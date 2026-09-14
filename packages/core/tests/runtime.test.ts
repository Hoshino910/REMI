import { describe, expect, it } from 'vitest'
import {
  SelectiveMemoryRuntime,
  type MemoryRecord,
  type MemoryStore,
  type RetrievalTrace,
} from '../src/index.js'

class TestStore implements MemoryStore {
  readonly records = new Map<string, MemoryRecord>()
  readonly traces: RetrievalTrace[] = []

  async put(record: MemoryRecord): Promise<boolean> {
    if (this.records.has(record.id)) return false
    this.records.set(record.id, record)
    return true
  }

  async listBySession(sessionId: string, limit: number): Promise<readonly MemoryRecord[]> {
    return [...this.records.values()].filter(item => item.sessionId === sessionId).slice(0, limit)
  }

  async touch(): Promise<void> {}

  async appendTrace(trace: RetrievalTrace): Promise<void> {
    this.traces.push(trace)
  }

  async stats() {
    return { memories: this.records.size, traces: this.traces.length }
  }

  async close(): Promise<void> {}
}

describe('SelectiveMemoryRuntime', () => {
  it('retrieves relevant memory and exposes component scores', async () => {
    const store = new TestStore()
    const runtime = new SelectiveMemoryRuntime(store, { minScore: 0.05 })
    const now = Date.UTC(2026, 8, 14)
    await runtime.ingest({
      sessionId: 's1', sourceEventSeq: 1, role: 'user', sourceType: 'user/message',
      content: '数据库使用 SQLite，文件放在项目目录。', timestamp: now - 1_000,
    })
    await runtime.ingest({
      sessionId: 's1', sourceEventSeq: 2, role: 'user', sourceType: 'user/message',
      content: '午饭吃了面条。', timestamp: now - 500,
    })

    const result = await runtime.retrieve({
      sessionId: 's1', query: '项目的 SQLite 数据库放在哪里？', tokenBudget: 300, now,
    })

    expect(result.memories[0]?.memory.content).toContain('SQLite')
    expect(result.trace.candidates[0]?.embeddingScore).toBeGreaterThanOrEqual(0)
    expect(result.trace.candidates[0]?.recencyScore).toBeGreaterThan(0)
    expect(result.text).toContain('<memory-context')
  })

  it('honors a token budget', async () => {
    const store = new TestStore()
    const runtime = new SelectiveMemoryRuntime(store, { minScore: 0 })
    await runtime.ingest({
      sessionId: 's2', sourceEventSeq: 1, role: 'user', sourceType: 'user/message',
      content: 'A'.repeat(2_000), timestamp: 1,
    })
    const result = await runtime.retrieve({ sessionId: 's2', query: 'A', tokenBudget: 40, now: 2 })
    expect(result.memories).toHaveLength(0)
    expect(result.estimatedTokens).toBe(0)
  })

  it('creates a smaller deterministic continuity checkpoint', async () => {
    const runtime = new SelectiveMemoryRuntime(new TestStore())
    const result = await runtime.compact({
      sessionId: 's3',
      tokenBudget: 120,
      entries: [
        { role: 'user', content: '目标是做 Harness 插件。', timestamp: 1, importance: 0.9 },
        { role: 'assistant', content: '将 Core 与适配器解耦。', timestamp: 2, importance: 0.8 },
        { role: 'assistant', content: '不实现复杂 Hebbian。', timestamp: 3, importance: 0.7 },
      ],
    })
    expect(result.text).toContain('Extractive continuity checkpoint')
    expect(result.trace.selectedEntries).toBeGreaterThan(0)
    expect(result.estimatedTokens).toBeLessThanOrEqual(140)
  })
})
