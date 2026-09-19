import { normalizeText, tokenize } from './similarity.js'

export type MemoryContentKind = 'statement' | 'question' | 'acknowledgement'

/** Lightweight bilingual heuristics, not fact extraction or a trained model.
 * Remove output instructions without changing the durable original text.
 */
export function retrievalView(content: string): string {
  return normalizeText(content)
    .replace(/(?:只(?:输出|回复)|仅(?:输出|回复)|不要(?:猜测|复述|总结)|不(?:猜测|调用工具|搜索网页|读写文件|执行命令)).*$/iu, '')
    .replace(/\b(?:only (?:output|reply|respond|return)|do not (?:guess|repeat|summari[sz]e|use tools)).*$/iu, '')
    .replace(/(?:请)?(?:回溯|回忆|回顾|记住|告诉我|根据|最早的|之前的|前面的)|(?:必须保留的)?虚构约定|约定|只输出相应字段/gu, ' ')
    .replace(/\b(?:please|recall|remember|retrieve|earliest|previous|original|agreement|agreed|output|return|json|what|which|where|when|how|the|a|an|of|for|and|or|is|was|are|were|we|our|my|to|in)\b/giu, ' ')
    .replace(/\bstorage\b/giu, 'store').replace(/\bused\b/giu, 'use')
    .replace(/(?:是什么|是多少|在哪里|什么|哪个|如何|输出|相应字段|不猜测)/gu, ' ')
    .replace(/\s+/g, ' ').trim()
}

export function contentKind(content: string): MemoryContentKind {
  const value = normalizeText(content)
  if (/^(?:约定|包装要求|发货要求|素材\d+)?已收到[。.!]?$/u.test(value)
    || /^(?:ok|okay|thanks|thank you|received|acknowledged|got it)[.!]?$/iu.test(value)) return 'acknowledgement'
  // Examine the meaningful first clause, not a trailing "only reply" request.
  const primary = value.split(/只(?:回复|输出)|仅(?:回复|输出)|\bonly (?:reply|output|return)\b/iu)[0] ?? value
  if (/^(?:请)?(?:回溯|回忆|回顾|告诉我|查询)|^(?:我们|之前|最早).*(?:什么|哪个|是多少|在哪里)|^(?:please\s+)?(?:recall|retrieve|tell me|what|which|where|when|how)\b/iu.test(primary)
    || /[?？]\s*$/u.test(primary)) return 'question'
  return 'statement'
}

export function utilityFactor(kind: MemoryContentKind): number {
  return kind === 'question' ? 0.2 : kind === 'acknowledgement' ? 0.08 : 1
}

function terms(content: string): Set<string> {
  // Keep bilingual words, identifiers, numbers and CJK n-grams. Single Han
  // characters receive less weight rather than being discarded completely.
  return new Set(tokenize(retrievalView(content)))
}

export function lexicalRanker(query: string, contents: readonly string[]) {
  const queryTerms = terms(query)
  const documents = contents.map(terms)
  const frequency = new Map<string, number>()
  for (const document of documents) for (const token of document) frequency.set(token, (frequency.get(token) ?? 0) + 1)
  const weight = (token: string) => (1 + Math.log((documents.length + 1) / ((frequency.get(token) ?? 0) + 1)))
    * (/^\p{Script=Han}$/u.test(token) ? 0.25 : 1)
  const total = (set: Set<string>) => [...set].reduce((sum, token) => sum + weight(token), 0)
  const queryWeight = total(queryTerms)
  return documents.map(document => {
    const shared = [...queryTerms].reduce((sum, token) => sum + (document.has(token) ? weight(token) : 0), 0)
    const union = queryWeight + total(document) - shared
    return { queryCoverage: queryWeight === 0 ? 0 : shared / queryWeight, lexicalScore: union === 0 ? 0 : shared / union }
  })
}
