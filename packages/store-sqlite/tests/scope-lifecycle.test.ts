import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SelectiveMemoryRuntime, type MemoryInput } from '@dsh-memory/core'
import { SqliteMemoryStore } from '../src/index.js'

const fact = (sessionId: string, sourceEventSeq: number, content: string): MemoryInput => ({
  sessionId, sourceEventSeq, role: 'user', sourceType: 'user/message', content, timestamp: sourceEventSeq,
})

describe('scope and lifecycle integration', () => {
  it('reuses a bounded project Hebbian graph in a new session and isolates other owners', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remi-project-graph-'))
    let store = new SqliteMemoryStore({ filename: join(dir, 'test.sqlite') })
    try {
      let runtime = new SelectiveMemoryRuntime(store, { minScore: 0 })
      for (const session of ['a', 'b']) await store.bindSessionScope(session, { ownerId: 'alice', projectId: 'cedar' })
      await store.bindSessionScope('foreign', { ownerId: 'bob', projectId: 'cedar' })
      await runtime.ingest(fact('a', 1, 'Cedar deployment manifest is violet.'))
      await runtime.ingest(fact('a', 2, 'Cedar deployment signer is Mira.'))
      const request = { sessionId: 'a', scope: 'project' as const, query: 'Cedar deployment manifest signer', tokenBudget: 600, now: 10 }
      const first = await runtime.retrieve(request)
      expect(first.trace.reinforcedEdges).toBe(1)
      await store.close(); store = new SqliteMemoryStore({ filename: join(dir, 'test.sqlite') })
      runtime = new SelectiveMemoryRuntime(store, { minScore: 0 })
      const second = await runtime.retrieve({ ...request, sessionId: 'b', now: 11 })
      expect(second.trace.associationEdgesRead).toBe(1)
      expect(second.trace.associationBoostedCandidates).toBe(2)
      const ids = second.memories.map(item => item.memory.id)
      expect(await store.listAssociations('foreign', ids, 10, 'project')).toEqual([])
      expect(await store.listAssociations('b', ids, 10)).toEqual([])
      await expect(store.reinforceAssociations({ sessionId: 'foreign', scope: 'project', memoryIds: ids,
        activations: Object.fromEntries(ids.map(id => [id, 1])), at: 12, learningRate: 0.1,
        maxWeight: 1, halfLifeDays: 45, maxEdgesPerSession: 2048 })).rejects.toThrow('scope')
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('persists bindings across restart; defaults to session; isolates owner/project before LIMIT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remi-scope-'))
    let store = new SqliteMemoryStore({ filename: join(dir, 'test.sqlite') })
    try {
      let runtime = new SelectiveMemoryRuntime(store)
      for (const [session, owner, project, port] of [
        ['a', 'alice', 'cedar', '8247'], ['b', 'alice', 'cedar', ''],
        ['c', 'bob', 'cedar', '9999'], ['d', 'alice', 'maple', '7777'],
      ]) {
        await store.bindSessionScope(session!, { ownerId: owner!, projectId: project! })
        if (port) await runtime.ingest(fact(session!, 1, `Cedar service port is ${port}.`))
      }
      await store.close()
      store = new SqliteMemoryStore({ filename: join(dir, 'test.sqlite') })
      runtime = new SelectiveMemoryRuntime(store)
      const request = { sessionId: 'b', query: 'What is the Cedar service port?', tokenBudget: 400 }
      expect((await runtime.retrieve(request)).memories).toHaveLength(0)
      const shared = await runtime.retrieve({ ...request, scope: 'project' })
      expect(shared.memories.map(item => item.memory.sessionId)).toEqual(['a'])
      expect(shared.text).toContain('8247')
      expect(shared.text).not.toMatch(/9999|7777/)
      expect(shared.trace.reinforcedEdges).toBe(0)
      expect((await store.listByScope('b', 1))[0]?.sessionId).toBe('a')
      await expect(store.bindSessionScope('b', { ownerId: 'bob', projectId: 'cedar' })).rejects.toThrow('immutable')
      await expect(runtime.retrieve({ ...request, sessionId: 'unbound', scope: 'project' })).rejects.toThrow('bound')
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('supports atomic project corrections without granting another owner access', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:' })
    try {
      const runtime = new SelectiveMemoryRuntime(store)
      for (const session of ['a', 'b']) await store.bindSessionScope(session, { ownerId: 'alice', projectId: 'cedar' })
      await store.bindSessionScope('foreign', { ownerId: 'bob', projectId: 'cedar' })
      await runtime.ingest(fact('a', 1, 'Cedar service port is 6389.'))
      const target = (await store.listBySession('a', 1))[0]!
      const revision = { sessionId: 'b', targetMemoryId: target.id,
        replacement: fact('b', 2, 'Cedar service port is 8247.'), at: 2, reason: 'explicit', source: 'manual' as const }
      await expect(runtime.supersede({ ...revision, sessionId: 'foreign', replacement: fact('foreign', 2, 'Cedar service port is 0000.') })).rejects.toThrow()
      await expect(runtime.supersede(revision)).resolves.toBe(true)
      await expect(runtime.supersede(revision)).resolves.toBe(false)
      const current = await runtime.retrieve({ sessionId: 'b', scope: 'project', query: 'current Cedar service port', tokenBudget: 600 })
      expect(current.text).toContain('8247'); expect(current.text).not.toContain('6389')
      const history = await runtime.retrieve({ sessionId: 'b', scope: 'project', query: 'Cedar service port history', tokenBudget: 600 })
      expect(history.text).toContain('6389'); expect(history.text).toContain('8247')
      // Default deletion follows the cross-session revision chain.
      const removed = await store.forget({ sessionId: 'b', memoryIds: [target.id], mode: 'delete' })
      expect(removed.affectedIds).toHaveLength(2)
      expect((await runtime.retrieve({ sessionId: 'b', scope: 'project', query: 'Cedar service port history', tokenBudget: 600 })).memories).toHaveLength(0)
    } finally { await store.close() }
  })

  it.each(['exclude', 'delete', 'purge'] as const)('%s prevents recall and graph resurrection after restart and event replay', async mode => {
    const dir = mkdtempSync(join(tmpdir(), 'remi-forget-'))
    let store = new SqliteMemoryStore({ filename: join(dir, 'test.sqlite') })
    try {
      let runtime = new SelectiveMemoryRuntime(store, { minScore: 0 })
      const original = fact('a', 1, 'Cedar deployment secret is violet-42.')
      await runtime.ingest(original)
      await runtime.ingest(fact('a', 2, 'Cedar deployment signer is Mira.'))
      await runtime.retrieve({ sessionId: 'a', query: 'Cedar deployment', tokenBudget: 600 })
      expect((await store.stats()).associations).toBe(1)
      const target = (await store.listBySession('a', 10)).find(record => record.content.includes('violet'))!
      await expect(store.forget({ sessionId: 'foreign', memoryIds: [target.id], mode })).rejects.toThrow()
      const removed = await store.forget({ sessionId: 'a', memoryIds: [target.id], mode })
      expect(removed.removedEdges).toBe(1)
      await store.close(); store = new SqliteMemoryStore({ filename: join(dir, 'test.sqlite') })
      runtime = new SelectiveMemoryRuntime(store)
      expect(await runtime.ingest(original)).toBe(false)
      expect(await runtime.ingest({ ...original, sourceEventSeq: 999 })).toBe(false)
      const recall = await runtime.retrieve({ sessionId: 'a', query: 'Cedar deployment secret history', tokenBudget: 600, includeSuperseded: true })
      expect(recall.text).not.toContain('violet-42')
      expect((await store.stats()).associations).toBe(0)
      const checkpoint = await runtime.compact({ sessionId: 'a', tokenBudget: 600,
        entries: [{ role: 'user', content: original.content, timestamp: 1 }] })
      expect(checkpoint.text).not.toContain('violet-42')
      if (mode === 'purge') {
        const tombstone = (await store.listBySession('a', 10, { includeInactive: true })).find(record => record.id === target.id)!
        expect(tombstone.content).toBe(''); expect(tombstone.embedding).toEqual([])
        expect(tombstone.metadata).toEqual({}); expect(tombstone.emotion).toBeUndefined()
      }
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('rolls back an entire forget batch when one target is invalid', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:' })
    try {
      const runtime = new SelectiveMemoryRuntime(store)
      await runtime.ingest(fact('a', 1, 'Cedar port is 8247.'))
      const target = (await store.listBySession('a', 1))[0]!
      await expect(store.forget({ sessionId: 'a', memoryIds: [target.id, 'missing'], mode: 'purge' })).rejects.toThrow()
      expect((await store.listBySession('a', 1))[0]?.content).toBe('Cedar port is 8247.')
    } finally { await store.close() }
  })
})
