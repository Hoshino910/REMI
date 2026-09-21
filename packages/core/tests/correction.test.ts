import { describe, expect, it } from 'vitest'
import {
  detectDeterministicCorrection,
  resolveDeterministicCorrectionTarget,
  type MemoryRecord,
} from '../src/index.js'

const memory = (id: string, content: string, createdAt = 1): MemoryRecord => ({
  id, sessionId: 's', role: 'user', sourceType: 'user/message', content,
  contentHash: id, embedding: [], importance: 0.7, status: 'active', validFrom: createdAt,
  createdAt, lastAccessedAt: createdAt, accessCount: 0, estimatedTokens: 10, metadata: {},
})

describe('deterministic current-truth corrections', () => {
  it.each([
    ['把 Cedar 服务端口从 6389 改为 8247。', { subject: 'Cedar 服务端口', previousValue: '6389', newValue: '8247', pattern: 'zh-change' }],
    ['Change Cedar service port from 6389 to 8247.', { subject: 'Cedar service port', previousValue: '6389', newValue: '8247', pattern: 'en-change' }],
    ['Replace Cedar service port with 8247.', { subject: 'Cedar service port', newValue: '8247', pattern: 'en-replace' }],
  ])('parses an explicit completed correction: %s', (text, expected) => {
    expect(detectDeterministicCorrection(text)).toMatchObject(expected)
  })

  it.each([
    'We may change Cedar service port later.',
    '也许以后把 Cedar 服务端口改一下。',
    'What should the Cedar service port be?',
    'Cedar service port is 8247.',
  ])('does not infer a correction from ambiguous or ordinary text: %s', text => {
    expect(detectDeterministicCorrection(text)).toBeUndefined()
  })

  it('resolves exactly one active subject and previous value', () => {
    const intent = detectDeterministicCorrection('Change Cedar service port from 6389 to 8247.')!
    const result = resolveDeterministicCorrectionTarget(intent, [
      memory('cedar', 'Cedar service port is 6389.'),
      memory('maple', 'Maple service port is 6389.'),
    ])
    expect(result.status).toBe('resolved')
    expect(result.target?.id).toBe('cedar')
  })

  it('refuses to mutate when the same subject matches multiple active records', () => {
    const intent = detectDeterministicCorrection('Change Cedar service port to 8247.')!
    const result = resolveDeterministicCorrectionTarget(intent, [
      memory('one', 'Cedar service port is 6389.', 1),
      memory('two', 'Cedar service port remains 6389.', 2),
    ])
    expect(result.status).toBe('ambiguous')
    expect(result.target).toBeUndefined()
  })
})
