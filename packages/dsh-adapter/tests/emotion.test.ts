import { describe, expect, it } from 'vitest'
import { parseEmotionJson } from '../src/emotion.js'

describe('emotion output parsing', () => {
  it('accepts fenced model output and clamps untrusted values', () => {
    const emotion = parseEmotionJson(`result:\n{\n  "valence": 4,\n  "arousal": 0.8,\n  "dominance": -2,\n  "labels": [" Frustrated ", "URGENT", 7, "extra"],\n  "confidence": 0.7\n}`)
    expect(emotion).toEqual({
      valence: 1,
      arousal: 0.8,
      dominance: 0,
      labels: ['frustrated', 'urgent', 'extra'],
      confidence: 0.7,
      source: 'model',
    })
  })

  it('rejects output without a JSON object', () => {
    expect(() => parseEmotionJson('neutral')).toThrow(/no JSON object/)
  })
})
