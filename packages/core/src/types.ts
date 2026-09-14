export type MemoryRole = 'user' | 'assistant' | 'tool' | 'unknown'

export interface MemoryInput {
  readonly sessionId: string
  readonly sourceEventSeq?: number
  readonly role: MemoryRole
  readonly sourceType: string
  readonly content: string
  readonly timestamp: number
  readonly importance?: number
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
}

export interface MemoryRecord {
  readonly id: string
  readonly sessionId: string
  readonly sourceEventSeq?: number
  readonly role: MemoryRole
  readonly sourceType: string
  readonly content: string
  readonly contentHash: string
  readonly embedding: readonly number[]
  readonly importance: number
  readonly createdAt: number
  readonly lastAccessedAt: number
  readonly accessCount: number
  readonly estimatedTokens: number
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>
}

export type CandidateDecision = 'selected' | 'below-min-score' | 'budget' | 'limit'

export interface RetrievalCandidateTrace {
  readonly memoryId: string
  readonly embeddingScore: number
  readonly lexicalScore: number
  readonly similarityScore: number
  readonly recencyScore: number
  readonly importanceScore: number
  readonly finalScore: number
  readonly estimatedTokens: number
  readonly decision: CandidateDecision
}

export interface RetrievalTrace {
  readonly traceId: string
  readonly sessionId: string
  readonly queryFingerprint: string
  readonly queryChars: number
  readonly startedAt: number
  readonly durationMs: number
  readonly tokenBudget: number
  readonly estimatedTokens: number
  readonly candidateCount: number
  readonly selectedCount: number
  readonly weights: RetrievalWeights
  readonly candidates: readonly RetrievalCandidateTrace[]
}

export interface RetrievedMemory {
  readonly memory: MemoryRecord
  readonly finalScore: number
  readonly estimatedTokens: number
}

export interface RetrievalRequest {
  readonly sessionId: string
  readonly query: string
  readonly tokenBudget: number
  readonly limit?: number
  readonly now?: number
}

export interface RetrievalResult {
  readonly memories: readonly RetrievedMemory[]
  readonly text: string
  readonly estimatedTokens: number
  readonly trace: RetrievalTrace
}

export interface RetrievalWeights {
  readonly similarity: number
  readonly recency: number
  readonly importance: number
}

export interface MemoryRuntimeConfig {
  readonly embeddingDimensions?: number
  readonly recencyHalfLifeDays?: number
  readonly minScore?: number
  readonly maxCandidates?: number
  readonly maxItemChars?: number
  readonly traceCandidateLimit?: number
  readonly weights?: Partial<RetrievalWeights>
}

export interface CompactionEntry {
  readonly role: MemoryRole
  readonly content: string
  readonly timestamp: number
  readonly importance?: number
}

export interface CompactionRequest {
  readonly sessionId: string
  readonly entries: readonly CompactionEntry[]
  readonly tokenBudget: number
  readonly now?: number
}

export interface CompactionTrace {
  readonly traceId: string
  readonly sessionId: string
  readonly startedAt: number
  readonly durationMs: number
  readonly inputEntries: number
  readonly inputEstimatedTokens: number
  readonly selectedEntries: number
  readonly selectedInputIndexes: readonly number[]
  readonly outputEstimatedTokens: number
  readonly tokenBudget: number
}

export interface CompactionResult {
  readonly text: string
  readonly estimatedTokens: number
  readonly trace: CompactionTrace
}

export interface StoreStats {
  readonly memories: number
  readonly traces: number
}

export interface MemoryStore {
  put(record: MemoryRecord): Promise<boolean>
  listBySession(sessionId: string, limit: number): Promise<readonly MemoryRecord[]>
  touch(ids: readonly string[], at: number): Promise<void>
  appendTrace(trace: RetrievalTrace): Promise<void>
  stats(): Promise<StoreStats>
  close(): Promise<void>
}

export interface MemoryRuntime {
  ingest(event: MemoryInput): Promise<boolean>
  retrieve(input: RetrievalRequest): Promise<RetrievalResult>
  compact(input: CompactionRequest): Promise<CompactionResult>
}
