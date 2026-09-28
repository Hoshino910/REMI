import {
  SelectiveMemoryRuntime,
  type AssociationEdge,
  type AssociationReinforcement,
  type AssociationReinforcementResult,
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
  readonly limit?: number
  readonly now?: number
  /** Optional retrievals used to build graph state before the measured query. */
  readonly primingQueries?: readonly {
    readonly query: string
    readonly tokenBudget?: number
    readonly limit?: number
    readonly now?: number
  }[]
}

export interface BenchmarkRun {
  readonly scoringVersion: 'raw-v0.2' | 'content-aware-v1' | 'window-hygiene-v2'
  readonly ablation: string
  readonly cases: number
  readonly hitRateAtK: number
  readonly meanCandidateCount: number
  readonly meanSelectedCount: number
  readonly meanRetrievalTokens: number
  readonly meanDurationMs: number
  readonly meanAssociationEdgesRead: number
  readonly meanAssociationEdgesApplied: number
  readonly meanAssociationBoostedCandidates: number
  readonly meanReinforcedEdges: number
}

export interface BenchmarkReport {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly runs: readonly BenchmarkRun[]
}

class MemoryArrayStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>()
  private readonly edges = new Map<string, AssociationEdge>()

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

  async listAssociations(
    sessionId: string,
    memoryIds: readonly string[],
    limit: number,
  ): Promise<readonly AssociationEdge[]> {
    const selected = new Set(memoryIds)
    return [...this.edges.values()]
      .filter(edge => edge.sessionId === sessionId
        && (selected.has(edge.sourceMemoryId) || selected.has(edge.targetMemoryId)))
      .sort((left, right) => right.weight - left.weight || right.updatedAt - left.updatedAt)
      .slice(0, limit)
  }

  async reinforceAssociations(input: AssociationReinforcement): Promise<AssociationReinforcementResult> {
    const ids = [...new Set(input.memoryIds)].sort()
    let reinforcedEdges = 0
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const sourceMemoryId = ids[left]
        const targetMemoryId = ids[right]
        if (sourceMemoryId === undefined || targetMemoryId === undefined) continue
        const key = `${input.sessionId}:${sourceMemoryId}:${targetMemoryId}`
        const existing = this.edges.get(key)
        const activation = Math.sqrt(
          Math.max(0, input.activations[sourceMemoryId] ?? 0)
          * Math.max(0, input.activations[targetMemoryId] ?? 0),
        )
        this.edges.set(key, {
          sessionId: input.sessionId,
          sourceMemoryId,
          targetMemoryId,
          weight: Math.min(input.maxWeight, (existing?.weight ?? 0) + input.learningRate * activation),
          coActivationCount: (existing?.coActivationCount ?? 0) + 1,
          createdAt: existing?.createdAt ?? input.at,
          updatedAt: input.at,
        })
        reinforcedEdges += 1
      }
    }
    const sessionEdges = [...this.edges.entries()]
      .filter(([, edge]) => edge.sessionId === input.sessionId)
      .sort(([, left], [, right]) => right.weight - left.weight
        || right.updatedAt - left.updatedAt
        || right.coActivationCount - left.coActivationCount
        || left.sourceMemoryId.localeCompare(right.sourceMemoryId)
        || left.targetMemoryId.localeCompare(right.targetMemoryId))
    const removed = sessionEdges.slice(input.maxEdgesPerSession)
    for (const [key] of removed) this.edges.delete(key)
    return {
      reinforcedEdges,
      prunedEdges: removed.length,
      storedEdges: sessionEdges.length - removed.length,
    }
  }

  async stats() { return { memories: this.records.size, traces: 0, associations: this.edges.size } }
  async close(): Promise<void> {}
}

const ABLATIONS: ReadonlyArray<{ name: string; config: MemoryRuntimeConfig }> = [
  { name: 'full', config: {} },
  { name: 'no_window_hygiene', config: { windowHygieneEnabled: false } },
  { name: 'no_hebbian', config: { hebbianEnabled: false, weights: { association: 0 } } },
  { name: 'similarity_only', config: { hebbianEnabled: false, weights: { similarity: 1, recency: 0, importance: 0, association: 0, emotion: 0 } } },
  { name: 'no_recency', config: { weights: { similarity: 0.65, recency: 0, importance: 0.15, association: 0.15, emotion: 0.05 } } },
  { name: 'no_importance', config: { weights: { similarity: 0.65, recency: 0.15, importance: 0, association: 0.15, emotion: 0.05 } } },
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
  const associationEdgesRead: number[] = []
  const associationEdgesApplied: number[] = []
  const associationBoostedCandidates: number[] = []
  const reinforcedEdges: number[] = []

  for (const testCase of cases) {
    const runtime = new SelectiveMemoryRuntime(new MemoryArrayStore(), {
      minScore: 0.05,
      ...ablation.config,
    })
    for (const memory of testCase.memories) {
      await runtime.ingest({ ...memory, sessionId: testCase.sessionId })
    }
    for (const priming of testCase.primingQueries ?? []) {
      await runtime.retrieve({
        sessionId: testCase.sessionId,
        query: priming.query,
        tokenBudget: priming.tokenBudget ?? testCase.tokenBudget,
        ...(priming.limit === undefined ? {} : { limit: priming.limit }),
        ...(priming.now === undefined ? {} : { now: priming.now }),
      })
    }
    const result = await runtime.retrieve({
      sessionId: testCase.sessionId,
      query: testCase.query,
      tokenBudget: testCase.tokenBudget,
      ...(testCase.limit === undefined ? {} : { limit: testCase.limit }),
      ...(testCase.now === undefined ? {} : { now: testCase.now }),
    })
    hits.push(hit(result.memories.map(item => item.memory), testCase.relevantContentIncludes) ? 1 : 0)
    candidateCounts.push(result.trace.candidateCount)
    selectedCounts.push(result.trace.selectedCount)
    retrievalTokens.push(result.estimatedTokens)
    durations.push(result.trace.durationMs)
    associationEdgesRead.push(result.trace.associationEdgesRead)
    associationEdgesApplied.push(result.trace.associationEdgesApplied)
    associationBoostedCandidates.push(result.trace.associationBoostedCandidates)
    reinforcedEdges.push(result.trace.reinforcedEdges)
  }

  return {
    scoringVersion: ablation.config.contentAwareRetrievalEnabled === false
      ? 'raw-v0.2'
      : ablation.config.windowHygieneEnabled === false ? 'content-aware-v1' : 'window-hygiene-v2',
    ablation: ablation.name,
    cases: cases.length,
    hitRateAtK: mean(hits),
    meanCandidateCount: mean(candidateCounts),
    meanSelectedCount: mean(selectedCounts),
    meanRetrievalTokens: mean(retrievalTokens),
    meanDurationMs: mean(durations),
    meanAssociationEdgesRead: mean(associationEdgesRead),
    meanAssociationEdgesApplied: mean(associationEdgesApplied),
    meanAssociationBoostedCandidates: mean(associationBoostedCandidates),
    meanReinforcedEdges: mean(reinforcedEdges),
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
