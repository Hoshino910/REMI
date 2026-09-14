import { afterEach, describe, expect, it } from 'vitest'
import { SelectiveMemoryRuntime } from '@dsh-memory/core'
import { SqliteMemoryStore } from '../src/index.js'

const stores: SqliteMemoryStore[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
})

describe('SqliteMemoryStore', () => {
  it('persists memories and retrieval traces', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:' })
    stores.push(store)
    const runtime = new SelectiveMemoryRuntime(store, { minScore: 0 })
    await runtime.ingest({
      sessionId: 'sqlite-session', sourceEventSeq: 4, role: 'user',
      sourceType: 'user/message', content: 'Remember the SQLite decision.', timestamp: 10,
    })
    await runtime.retrieve({
      sessionId: 'sqlite-session', query: 'SQLite decision', tokenBudget: 200, now: 20,
    })

    await expect(store.stats()).resolves.toEqual({ memories: 1, traces: 1, associations: 0 })
    await expect(store.listTraces('sqlite-session')).resolves.toHaveLength(1)
  })

  it('deduplicates a replayed session event', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:' })
    stores.push(store)
    const runtime = new SelectiveMemoryRuntime(store)
    const input = {
      sessionId: 'dedupe', sourceEventSeq: 2, role: 'user' as const,
      sourceType: 'user/message', content: 'One durable fact.', timestamp: 10,
    }
    await expect(runtime.ingest(input)).resolves.toBe(true)
    await expect(runtime.ingest(input)).resolves.toBe(false)
    await expect(store.stats()).resolves.toEqual({ memories: 1, traces: 0, associations: 0 })
  })

  it('persists bounded Hebbian association edges', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:' })
    stores.push(store)
    const runtime = new SelectiveMemoryRuntime(store, { minScore: 0, hebbianLearningRate: 0.4 })
    await runtime.ingest({
      sessionId: 'edges', sourceEventSeq: 1, role: 'user', sourceType: 'user/message',
      content: 'Use a transparent memory window.', timestamp: 10,
    })
    await runtime.ingest({
      sessionId: 'edges', sourceEventSeq: 2, role: 'assistant', sourceType: 'assistant/message',
      content: 'The window is a replaceable runtime context snapshot.', timestamp: 11,
    })
    const result = await runtime.retrieve({
      sessionId: 'edges', query: 'transparent runtime context window', tokenBudget: 500, limit: 2, now: 20,
    })

    expect(result.trace.reinforcedEdges).toBe(1)
    await expect(store.stats()).resolves.toEqual({ memories: 2, traces: 1, associations: 1 })
    const ids = result.memories.map(item => item.memory.id)
    const edges = await store.listAssociations('edges', ids, 10)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.weight).toBeGreaterThan(0)
  })
})
