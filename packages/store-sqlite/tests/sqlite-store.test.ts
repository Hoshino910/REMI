import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SelectiveMemoryRuntime } from '@dsh-memory/core'
import { SqliteMemoryStore } from '../src/index.js'

const stores: SqliteMemoryStore[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SqliteMemoryStore', () => {
  it('quarantines historical injections before LIMIT without deleting records', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:', excludedSourceKinds: ['plugin', 'skill-catalog', 'agent-instructions'] })
    stores.push(store)
    const runtime = new SelectiveMemoryRuntime(store, { minScore: 0 })
    for (const [seq, sourceKind] of ['user', 'plugin', 'skill-catalog', 'agent-instructions'].entries()) {
      await runtime.ingest({ sessionId: 'legacy', sourceEventSeq: seq, role: 'user', sourceType: 'user/message', content: `fact ${sourceKind}`, timestamp: seq + 1, metadata: { sourceKind } })
    }
    const records = await store.listBySession('legacy', 1)
    expect(records).toHaveLength(1)
    expect(records[0]?.metadata.sourceKind).toBe('user')
    expect((await runtime.retrieve({ sessionId: 'legacy', query: 'fact', tokenBudget: 500 })).trace.candidateCount).toBe(1)
    expect((await store.stats()).memories).toBe(4)
  })
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

  it('persists lifecycle fields and excludes inactive records by default', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:' })
    stores.push(store)
    const runtime = new SelectiveMemoryRuntime(store)
    await runtime.ingest({
      sessionId: 'lifecycle', sourceEventSeq: 1, role: 'user', sourceType: 'user/message',
      content: 'Old port is 6389.', timestamp: 10, status: 'superseded',
      supersededByMemoryId: 'm_new', validFrom: 10, validUntil: 20,
      revisionReason: 'Port changed.', revisionSource: 'manual',
    })
    await runtime.ingest({
      sessionId: 'lifecycle', sourceEventSeq: 2, role: 'user', sourceType: 'user/message',
      content: 'Current port is 8247.', timestamp: 20, supersedesMemoryId: 'm_old',
    })

    const active = await store.listBySession('lifecycle', 10)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ status: 'active', content: 'Current port is 8247.', validFrom: 20 })
    const all = await store.listBySession('lifecycle', 10, { includeInactive: true })
    expect(all).toHaveLength(2)
    expect(all[1]).toMatchObject({
      status: 'superseded', supersededByMemoryId: 'm_new', validFrom: 10,
      validUntil: 20, revisionReason: 'Port changed.', revisionSource: 'manual',
    })
  })

  it('migrates a v2 database to lifecycle schema v3 without losing memories', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'remi-v2-migration-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'memory.sqlite')
    const legacy = new DatabaseSync(filename)
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta VALUES ('schema_version', '2');
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_event_seq INTEGER,
        role TEXT NOT NULL, source_type TEXT NOT NULL, content TEXT NOT NULL,
        content_hash TEXT NOT NULL, embedding BLOB NOT NULL, importance REAL NOT NULL,
        created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0, estimated_tokens INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      ) STRICT;
    `)
    legacy.prepare('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'm_legacy', 'legacy-session', 7, 'user', 'user/message', 'Keep this decision.',
      'hash', new Uint8Array(new Float32Array([1]).buffer), 0.8, 123, 123, 0, 4, '{}',
    )
    legacy.close()

    const store = new SqliteMemoryStore({ filename })
    stores.push(store)
    const records = await store.listBySession('legacy-session', 10, { includeInactive: true })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: 'm_legacy', status: 'active', validFrom: 123 })
    const inspection = new DatabaseSync(filename, { readOnly: true })
    expect(inspection.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '3' })
    inspection.close()
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
