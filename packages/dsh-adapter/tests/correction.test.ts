import { describe, expect, it } from 'vitest'
import { SelectiveMemoryRuntime } from '@dsh-memory/core'
import { SqliteMemoryStore } from '@dsh-memory/store-sqlite'
import { ingestWithCurrentTruth } from '../src/correction.js'

describe('DSH current-truth observation', () => {
  it('atomically replaces one unambiguous active fact', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:' })
    const runtime = new SelectiveMemoryRuntime(store)
    await runtime.ingest({
      sessionId: 's1', sourceEventSeq: 1, role: 'user', sourceType: 'user/message',
      content: 'The Cedar service port is 6389.', timestamp: 1,
    })

    const result = await ingestWithCurrentTruth(runtime, store, {
      sessionId: 's1', sourceEventSeq: 2, role: 'user', sourceType: 'user/message',
      content: 'Change the Cedar service port from 6389 to 8247.', timestamp: 2,
    }, { enabled: true, maxCandidates: 100 })

    expect(result).toMatchObject({
      inserted: true,
      correction: { resolution: 'resolved', pattern: 'en-change', candidateCount: 1 },
    })
    const records = await store.listBySession('s1', 10, { includeInactive: true })
    expect(records).toHaveLength(2)
    expect(records.find(record => record.status === 'active')?.content).toContain('8247')
    expect(records.find(record => record.status === 'superseded')).toMatchObject({
      content: 'The Cedar service port is 6389.',
      validUntil: 2,
      revisionSource: 'deterministic',
    })
    await store.close()
  })

  it('records an ambiguous correction without mutating either candidate', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:' })
    const runtime = new SelectiveMemoryRuntime(store)
    await runtime.ingest({
      sessionId: 's2', sourceEventSeq: 1, role: 'user', sourceType: 'user/message',
      content: 'The Cedar service port is 6389 for staging.', timestamp: 1,
    })
    await runtime.ingest({
      sessionId: 's2', sourceEventSeq: 2, role: 'user', sourceType: 'user/message',
      content: 'The Cedar service port is 6389 for production.', timestamp: 2,
    })

    const result = await ingestWithCurrentTruth(runtime, store, {
      sessionId: 's2', sourceEventSeq: 3, role: 'user', sourceType: 'user/message',
      content: 'Change the Cedar service port from 6389 to 8247.', timestamp: 3,
    }, { enabled: true, maxCandidates: 100 })

    expect(result).toMatchObject({
      inserted: true,
      correction: { resolution: 'ambiguous', pattern: 'en-change', candidateCount: 2 },
    })
    const records = await store.listBySession('s2', 10, { includeInactive: true })
    expect(records).toHaveLength(3)
    expect(records.every(record => record.status === 'active')).toBe(true)
    await store.close()
  })
})
