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

    await expect(store.stats()).resolves.toEqual({ memories: 1, traces: 1 })
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
    await expect(store.stats()).resolves.toEqual({ memories: 1, traces: 0 })
  })
})
