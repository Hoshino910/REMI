import { describe, expect, it } from 'vitest'
import {
  inferHeuristicEmotion,
  SelectiveMemoryRuntime,
  type AssociationEdge,
  type AssociationReinforcement,
  type MemoryRecord,
  type MemoryStore,
  type RetrievalTrace,
} from '../src/index.js'

class TestStore implements MemoryStore {
  readonly records = new Map<string, MemoryRecord>()
  readonly traces: RetrievalTrace[] = []
  readonly edges = new Map<string, AssociationEdge>()

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

  async listAssociations(
    sessionId: string,
    memoryIds: readonly string[],
    limit: number,
  ): Promise<readonly AssociationEdge[]> {
    const selected = new Set(memoryIds)
    return [...this.edges.values()]
      .filter(edge => edge.sessionId === sessionId
        && (selected.has(edge.sourceMemoryId) || selected.has(edge.targetMemoryId)))
      .slice(0, limit)
  }

  async reinforceAssociations(input: AssociationReinforcement): Promise<number> {
    const ids = [...new Set(input.memoryIds)].sort()
    let count = 0
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const sourceMemoryId = ids[left]
        const targetMemoryId = ids[right]
        if (sourceMemoryId === undefined || targetMemoryId === undefined) continue
        const key = `${input.sessionId}:${sourceMemoryId}:${targetMemoryId}`
        const existing = this.edges.get(key)
        this.edges.set(key, {
          sessionId: input.sessionId,
          sourceMemoryId,
          targetMemoryId,
          weight: Math.min(input.maxWeight, (existing?.weight ?? 0) + input.learningRate),
          coActivationCount: (existing?.coActivationCount ?? 0) + 1,
          createdAt: existing?.createdAt ?? input.at,
          updatedAt: input.at,
        })
        count += 1
      }
    }
    return count
  }

  async stats() {
    return { memories: this.records.size, traces: this.traces.length, associations: this.edges.size }
  }

  async close(): Promise<void> {}
}

describe('SelectiveMemoryRuntime', () => {
  it.each([
    ['请回溯最早的雾岭盒包装约定，输出颜色和禁止颜色。只输出相应字段的 JSON，不猜测、不调用工具。', '雾岭盒包装颜色只能使用墨绿色，禁止使用亮橙色。只回复已收到。', '请回溯最早的山泉盒包装约定，输出颜色和禁止颜色。只输出相应字段的 JSON，不猜测、不调用工具。'],
    ['Please recall the earliest Cedar database port agreement. Only output JSON.', 'Cedar database port is 9123. Only reply received.', 'Please recall the earliest Maple database port agreement. Only output JSON.'],
  ])('ranks answer-bearing facts ahead of boilerplate recall questions at K=1', async (query, fact, decoy) => {
    const store = new TestStore()
    const runtime = new SelectiveMemoryRuntime(store)
    for (const [seq, content] of [fact, decoy, query, '约定已收到'].entries()) {
      await runtime.ingest({ sessionId: 'ranking', sourceEventSeq: seq, role: 'user', sourceType: 'user/message', content, timestamp: seq + 1 })
    }
    const result = await runtime.retrieve({ sessionId: 'ranking', query, tokenBudget: 800, limit: 1, now: 10 })
    expect(result.memories[0]?.memory.content).toContain(fact.normalize('NFKC').split('.')[0])
    expect(result.trace.scoringVersion).toBe('content-aware-v1')
    expect(result.trace.candidates.some(c => c.contentKind === 'question' && c.utilityFactor === 0.2)).toBe(true)
  })

  it('does not retrieve unrelated facts solely through recency, importance or hash collision', async () => {
    const runtime = new SelectiveMemoryRuntime(new TestStore(), { minScore: 0 })
    await runtime.ingest({ sessionId: 'unknown', role: 'user', sourceType: 'user/message', content: 'SQLite database port is 6389.', importance: 1, timestamp: 10 })
    const result = await runtime.retrieve({ sessionId: 'unknown', query: '未设定仓库的地址是什么？', tokenBudget: 800, now: 11 })
    expect(result.memories).toHaveLength(0)
    expect(result.trace.candidates[0]?.decision).toBe('below-min-relevance')
  })

  it('does not reinforce questions even if explicitly selected as contextual background', async () => {
    const store = new TestStore()
    const runtime = new SelectiveMemoryRuntime(store, { minScore: 0 })
    for (const [seq, content] of ['What is the Cedar database port?', 'Please recall the Cedar database port.'].entries()) {
      await runtime.ingest({ sessionId: 'question-graph', sourceEventSeq: seq, role: 'user', sourceType: 'user/message', content, timestamp: seq + 1 })
    }
    const result = await runtime.retrieve({ sessionId: 'question-graph', query: 'Cedar database port', tokenBudget: 800, limit: 2, now: 10 })
    expect(result.memories).toHaveLength(2)
    expect(result.trace.reinforcedEdges).toBe(0)
  })

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

  it('never exceeds the budget after rendering the context wrapper', async () => {
    const runtime = new SelectiveMemoryRuntime(new TestStore(), { minScore: 0 })
    for (let index = 0; index < 6; index += 1) {
      await runtime.ingest({
        sessionId: 'render-budget', sourceEventSeq: index + 1, role: 'user',
        sourceType: 'user/message', content: `memory ${index} ${'detail '.repeat(90)}`, timestamp: index + 1,
      })
    }
    const result = await runtime.retrieve({
      sessionId: 'render-budget', query: 'memory detail', tokenBudget: 220, limit: 6, now: 10,
    })
    expect(result.estimatedTokens).toBeLessThanOrEqual(220)
    expect(result.trace.estimatedTokens).toBe(result.estimatedTokens)
  })

  it('reinforces and reuses Hebbian co-activation edges', async () => {
    const store = new TestStore()
    const runtime = new SelectiveMemoryRuntime(store, { minScore: 0, hebbianLearningRate: 0.5 })
    const now = Date.UTC(2026, 8, 14)
    await runtime.ingest({
      sessionId: 'graph', sourceEventSeq: 1, role: 'user', sourceType: 'user/message',
      content: 'The project database is SQLite.', timestamp: now - 2_000,
    })
    await runtime.ingest({
      sessionId: 'graph', sourceEventSeq: 2, role: 'assistant', sourceType: 'assistant/message',
      content: 'SQLite files live under the project memory directory.', timestamp: now - 1_000,
    })

    const first = await runtime.retrieve({
      sessionId: 'graph', query: 'SQLite project memory', tokenBudget: 500, limit: 2, now,
    })
    expect(first.trace.reinforcedEdges).toBe(1)
    expect(store.edges.size).toBe(1)

    const second = await runtime.retrieve({
      sessionId: 'graph', query: 'SQLite database', tokenBudget: 500, limit: 2, now: now + 1,
    })
    expect(second.trace.associationEdgesRead).toBe(1)
    expect(second.trace.candidates.some(candidate => candidate.associationScore > 0)).toBe(true)
  })

  it('derives bounded heuristic affect without a trained model', () => {
    const emotion = inferHeuristicEmotion('这个错误让我很烦，必须马上修复。')
    expect(emotion.source).toBe('heuristic')
    expect(emotion.valence).toBeLessThan(0)
    expect(emotion.arousal).toBeGreaterThan(0.5)
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
