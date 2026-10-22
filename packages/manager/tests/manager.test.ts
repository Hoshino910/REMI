import { describe, it, expect } from 'vitest'
import { SqliteMemoryStore } from '@dsh-memory/store-sqlite'
import { MemoryManager, parseManagerRequest } from '../src/index.js'

describe('local memory manager', () => {
  it('requires explicit writes and previews retrieval without changing access, traces or graph', async () => {
    const store = new SqliteMemoryStore({ filename: ':memory:' })
    try {
      const manager = new MemoryManager(store)
      const request = { operation: 'write' as const, memory: { sessionId: 'a', sourceEventSeq: 1,
        role: 'user' as const, sourceType: 'manual', content: 'Cedar service port is 8247.', timestamp: 1 } }
      await expect(manager.execute(request)).rejects.toThrow('write')
      expect(await manager.execute(request, true)).toEqual({ inserted: true })
      const before = await store.stats()
      await manager.execute({ operation: 'recall', request: { sessionId: 'a', query: 'Cedar service port', tokenBudget: 400 } })
      expect(await store.stats()).toEqual(before)
      expect((await store.listBySession('a', 1))[0]?.accessCount).toBe(0)
    } finally { await store.close() }
  })
  it.each([
    { operation: 'forget', request: { sessionId: 'a', memoryIds: ['x'], mode: 'oops' } },
    { operation: 'recall', request: { sessionId: 'a', query: 'q', tokenBudget: -1 } },
    { operation: 'bind', sessionId: 'a', scope: { ownerId: '', projectId: 'p' } },
    { operation: 'eval' },
  ])('rejects malformed JSON boundary %#', value => { expect(() => parseManagerRequest(value)).toThrow() })
})
