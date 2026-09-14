import {
  SelectiveMemoryRuntime,
  type MemoryInput,
  type MemoryRecord,
  type MemoryRuntimeConfig,
  type MemoryStore,
  type RetrievalTrace,
} from '@dsh-memory/core'

export interface BenchmarkCase {
  readonly id: string
  readonly sessionId: string
  readonly memories: readonly Omit<MemoryInput, 'sessionId'>[]
  readonly query: string
  readonly relevantContentIncludes: readonly string[]
  readonly tokenBudget: number
  readonly now?: number
}

export interface BenchmarkRun {
  readonly ablation: string
  readonly cases: number
  readonly hitRateAtK: number
  readonly meanCandidateCount: number
  readonly meanSelectedCount: number
  readonly meanRetrievalTokens: number
  readonly meanDurationMs: number
}

export interface BenchmarkReport {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly runs: readonly BenchmarkRun[]
}

class MemoryArrayStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>()

  async put(record: MemoryRecord): Promise<boolean> {
    if (this.records.has(record.id)) return false
    this.records.set(record.id, record)
    return true
  }

  async listBySession(sessionId: string, limit: number): Promise<readonly MemoryRecord[]> {
    return [...this.records.values()].filter(record => record.sessionId === sessionId).slice(0, limit)
  }

  async touch(): Promise<void> {}
  async appendTrace(_trace: RetrievalTrace): Promise<void> {}
  async stats() { return { memories: this.records.size, traces: 0 } }
  async close(): Promise<void> {}
}

const ABLATIONS: ReadonlyArray<{ name: string; config: MemoryRuntimeConfig }> = [
  { name: 'full', config: {} },
  { name: 'similarity_only', config: { weights: { similarity: 1, recency: 0, importance: 0 } } },
  { name: 'no_recency', config: { weights: { similarity: 0.8, recency: 0, importance: 0.2 } } },
  { name: 'no_importance', config: { weights: { similarity: 0.76, recency: 0.24, importance: 0 } } },
]

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function hit(selected: readonly MemoryRecord[], needles: readonly string[]): boolean {
  if (needles.length === 0) return true
  return needles.every(needle => selected.some(record => record.content.includes(needle)))
}

async function runAblation(
  cases: readonly BenchmarkCase[],
  ablation: { name: string; config: MemoryRuntimeConfig },
): Promise<BenchmarkRun> {
  const hits: number[] = []
  const candidateCounts: number[] = []
  const selectedCounts: number[] = []
  const retrievalTokens: number[] = []
  const durations: number[] = []

  for (const testCase of cases) {
    const runtime = new SelectiveMemoryRuntime(new MemoryArrayStore(), {
      minScore: 0.05,
      ...ablation.config,
    })
    for (const memory of testCase.memories) {
      await runtime.ingest({ ...memory, sessionId: testCase.sessionId })
    }
    const result = await runtime.retrieve({
      sessionId: testCase.sessionId,
      query: testCase.query,
      tokenBudget: testCase.tokenBudget,
      ...(testCase.now === undefined ? {} : { now: testCase.now }),
    })
    hits.push(hit(result.memories.map(item => item.memory), testCase.relevantContentIncludes) ? 1 : 0)
    candidateCounts.push(result.trace.candidateCount)
    selectedCounts.push(result.trace.selectedCount)
    retrievalTokens.push(result.estimatedTokens)
    durations.push(result.trace.durationMs)
  }

  return {
    ablation: ablation.name,
    cases: cases.length,
    hitRateAtK: mean(hits),
    meanCandidateCount: mean(candidateCounts),
    meanSelectedCount: mean(selectedCounts),
    meanRetrievalTokens: mean(retrievalTokens),
    meanDurationMs: mean(durations),
  }
}

export async function runBenchmark(cases: readonly BenchmarkCase[]): Promise<BenchmarkReport> {
  const runs: BenchmarkRun[] = []
  for (const ablation of ABLATIONS) runs.push(await runAblation(cases, ablation))
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runs,
  }
}
