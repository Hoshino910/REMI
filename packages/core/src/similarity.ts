const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const TOKEN_RUN = /[\p{L}\p{N}_./:@\\-]+/gu

function fnv1a(value: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value).toLocaleLowerCase('en-US')
  const tokens: string[] = []
  for (const match of normalized.matchAll(TOKEN_RUN)) {
    const run = match[0]
    if (!CJK.test(run)) {
      tokens.push(run)
      continue
    }
    const chars = Array.from(run)
    for (let index = 0; index < chars.length; index += 1) {
      const current = chars[index]
      if (current === undefined) continue
      tokens.push(current)
      const next = chars[index + 1]
      if (next !== undefined) tokens.push(current + next)
    }
  }
  return tokens
}

export function hashedEmbedding(value: string, dimensions = 192): number[] {
  if (!Number.isSafeInteger(dimensions) || dimensions < 16) {
    throw new RangeError('embedding dimensions must be an integer >= 16')
  }
  const vector = new Array<number>(dimensions).fill(0)
  for (const token of tokenize(value)) {
    const bucket = fnv1a(token) % dimensions
    const sign = (fnv1a(token, 0x9e3779b9) & 1) === 0 ? 1 : -1
    vector[bucket] = (vector[bucket] ?? 0) + sign
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0))
  if (magnitude === 0) return vector
  return vector.map(item => item / magnitude)
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const size = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < size; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)))
}

export function lexicalSimilarity(left: string, right: string): number {
  const a = new Set(tokenize(left))
  const b = new Set(tokenize(right))
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

export function estimateTokens(value: string): number {
  let cjk = 0
  let other = 0
  for (const char of value) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4) + 4)
}

export function stableHash(value: string): string {
  const a = fnv1a(value).toString(16).padStart(8, '0')
  const b = fnv1a(value, 0x9e3779b9).toString(16).padStart(8, '0')
  return `${a}${b}`
}
