import {
  detectDeterministicCorrection,
  resolveDeterministicCorrectionTarget,
  type MemoryInput,
  type MemoryRuntime,
  type MemoryStore,
} from '@dsh-memory/core'

export interface CurrentTruthResult {
  readonly inserted: boolean
  readonly correction?: {
    readonly resolution: 'resolved' | 'not-found' | 'ambiguous'
    readonly pattern: 'zh-change' | 'en-change' | 'en-replace'
    readonly candidateCount: number
    readonly targetMemoryId?: string
  }
}

function replacementInput(input: MemoryInput) {
  return {
    ...(input.sourceEventSeq === undefined ? {} : { sourceEventSeq: input.sourceEventSeq }),
    role: input.role,
    sourceType: input.sourceType,
    content: input.content,
    timestamp: input.timestamp,
    ...(input.importance === undefined ? {} : { importance: input.importance }),
    ...(input.emotion === undefined ? {} : { emotion: input.emotion }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  }
}

/**
 * Applies only deterministic, explicit user corrections. Ambiguous and
 * unresolved messages remain ordinary memories and never mutate old records.
 */
export async function ingestWithCurrentTruth(
  runtime: MemoryRuntime,
  store: MemoryStore,
  input: MemoryInput,
  options: { readonly enabled: boolean; readonly maxCandidates: number },
): Promise<CurrentTruthResult> {
  if (!options.enabled || input.role !== 'user') {
    return { inserted: await runtime.ingest(input) }
  }
  const intent = detectDeterministicCorrection(input.content)
  if (intent === undefined) return { inserted: await runtime.ingest(input) }

  const records = await store.listBySession(input.sessionId, options.maxCandidates)
  const resolution = resolveDeterministicCorrectionTarget(intent, records)
  if (resolution.status !== 'resolved' || resolution.target === undefined) {
    return {
      inserted: await runtime.ingest(input),
      correction: {
        resolution: resolution.status,
        pattern: intent.pattern,
        candidateCount: resolution.candidates.length,
      },
    }
  }

  const inserted = await runtime.supersede({
    sessionId: input.sessionId,
    targetMemoryId: resolution.target.id,
    replacement: replacementInput(input),
    at: input.timestamp,
    reason: `Explicit ${intent.pattern} correction`,
    source: 'deterministic',
  })
  return {
    inserted,
    correction: {
      resolution: 'resolved',
      pattern: intent.pattern,
      candidateCount: resolution.candidates.length,
      targetMemoryId: resolution.target.id,
    },
  }
}
