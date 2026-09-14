import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { extractQuery, PLUGIN_ID } from '../src/extract.js'

describe('extractQuery', () => {
  it('prefers direct user input over plugin context', () => {
    const recall = createUserMessage({
      content: [{ type: 'text', text: 'old memory' }],
      source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'recall' },
    })
    const user = createUserMessage({
      content: [{ type: 'text', text: 'current question' }],
      source: { kind: 'user' },
    })
    expect(extractQuery([recall, user])).toBe('current question')
  })
})
