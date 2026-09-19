import { describe, expect, it } from 'vitest'
// Runtime audit helpers are deliberately standalone .mjs scripts.
// @ts-expect-error No declaration is required for a benchmark-only JS helper.
import { scoreFields } from '../scripts/score-recall-fields.mjs'

describe('recall field scoring', () => {
  it('accepts flat and correctly named nested JSON without changing answers', () => {
    for (const answer of ['{"项目":"新项目","端口":9123}', '```json\n{"新项目":{"端口":9123}}\n```']) {
      expect(scoreFields(answer, { port: 9123 }, '长测乙：新项目')[0].correct).toBe(true)
    }
  })
  it.each(['{"其他项目":{"端口":9123}}', '{"项目":"其他项目","端口":9123}', '{"端口":null}', '{"端口":9123,"port":9999}', '端口为9123'])('rejects wrong entity, null, conflicting aliases and non-JSON: %s', answer => {
    expect(scoreFields(answer, { port: 9123 }, '长测乙：新项目')[0].correct).toBe(false)
  })
})
