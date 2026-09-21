import { lexicalSimilarity, normalizeText } from './similarity.js'
import type { MemoryRecord } from './types.js'

export interface DeterministicCorrectionIntent {
  readonly operation: 'supersede'
  readonly subject: string
  readonly previousValue?: string
  readonly newValue: string
  readonly confidence: 1
  readonly source: 'deterministic'
  readonly pattern: 'zh-change' | 'en-change' | 'en-replace'
}

export interface CorrectionTargetScore {
  readonly memoryId: string
  readonly score: number
  readonly exactSubject: boolean
  readonly containsPreviousValue: boolean
}

export interface CorrectionTargetResolution {
  readonly status: 'resolved' | 'not-found' | 'ambiguous'
  readonly target?: MemoryRecord
  readonly candidates: readonly CorrectionTargetScore[]
}

function cleanCapture(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const cleaned = normalizeText(value).replace(/^(?:the|a|an)\s+/iu, '').replace(/\s+(?:value|setting)$/iu, '').trim()
  return cleaned.length === 0 ? undefined : cleaned
}

/**
 * Recognizes only explicit, completed corrections. Future/conditional language
 * is intentionally rejected; model inference belongs in the optional adapter.
 */
export function detectDeterministicCorrection(content: string): DeterministicCorrectionIntent | undefined {
  const text = normalizeText(content)
  if (/\b(?:may|might|could|perhaps|later|consider)\b|也许|可能|以后再|考虑/iu.test(text)) return undefined

  const zh = /(?:把|将)\s*(?<subject>[^，,。！？\n]{2,80}?)(?:\s*从\s*(?<previous>[^，,。！？\n]{1,60}?))?\s*(?:改为|改成|更改为|更新为|替换为)\s*(?<next>[^，,。！？\n]{1,80})/u.exec(text)
  if (zh?.groups !== undefined) {
    const subject = cleanCapture(zh.groups.subject)
    const previousValue = cleanCapture(zh.groups.previous)
    const newValue = cleanCapture(zh.groups.next)
    if (subject && newValue) return {
      operation: 'supersede', subject, ...(previousValue === undefined ? {} : { previousValue }),
      newValue, confidence: 1, source: 'deterministic', pattern: 'zh-change',
    }
  }

  const enChange = /\b(?:change|update|set)\s+(?<subject>[a-z0-9_. -]{2,80}?)(?:\s+from\s+(?<previous>[a-z0-9_. -]{1,60}?))?\s+to\s+(?<next>[a-z0-9_. -]{1,80}?)(?:[.!]|$)/iu.exec(text)
  if (enChange?.groups !== undefined) {
    const subject = cleanCapture(enChange.groups.subject)
    const previousValue = cleanCapture(enChange.groups.previous)
    const newValue = cleanCapture(enChange.groups.next)
    if (subject && newValue) return {
      operation: 'supersede', subject, ...(previousValue === undefined ? {} : { previousValue }),
      newValue, confidence: 1, source: 'deterministic', pattern: 'en-change',
    }
  }

  const enReplace = /\breplace\s+(?<subject>[a-z0-9_. -]{2,80}?)\s+(?:value\s+)?with\s+(?<next>[a-z0-9_. -]{1,80}?)(?:[.!]|$)/iu.exec(text)
  if (enReplace?.groups !== undefined) {
    const subject = cleanCapture(enReplace.groups.subject)
    const newValue = cleanCapture(enReplace.groups.next)
    if (subject && newValue) return {
      operation: 'supersede', subject, newValue, confidence: 1,
      source: 'deterministic', pattern: 'en-replace',
    }
  }
  return undefined
}

/** Resolves only one unambiguous active record; no closest-match mutation. */
export function resolveDeterministicCorrectionTarget(
  intent: DeterministicCorrectionIntent,
  records: readonly MemoryRecord[],
): CorrectionTargetResolution {
  const subject = normalizeText(intent.subject).toLocaleLowerCase()
  const previous = intent.previousValue?.toLocaleLowerCase()
  const candidates = records
    // A user correction owns the lifecycle of prior user-supplied facts.
    // Assistant echoes must not create a second mutation target.
    .filter(record => record.status === 'active' && record.role === 'user')
    .map(record => {
      const content = normalizeText(record.content).toLocaleLowerCase()
      const exactSubject = content.includes(subject)
      const containsPreviousValue = previous === undefined || content.includes(previous)
      return {
        record,
        exactSubject,
        containsPreviousValue,
        score: lexicalSimilarity(`${intent.subject} ${intent.previousValue ?? ''}`, record.content),
      }
    })
    .filter(item => item.exactSubject && item.containsPreviousValue)
    .sort((left, right) => right.score - left.score || right.record.createdAt - left.record.createdAt)

  const scores = candidates.map(({ record, score, exactSubject, containsPreviousValue }) => ({
    memoryId: record.id, score, exactSubject, containsPreviousValue,
  }))
  if (candidates.length === 0) return { status: 'not-found', candidates: scores }
  if (candidates.length > 1) return { status: 'ambiguous', candidates: scores }
  return { status: 'resolved', target: candidates[0]!.record, candidates: scores }
}
