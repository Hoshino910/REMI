import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { extractQuery, PLUGIN_ID, messageToCompactionEntry, sessionEventToMemoryInput } from '../src/extract.js'

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

describe('generated context quarantine', () => {
  it('preserves clean correlated checkpoints for repeated compaction, never ingestion', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'Continuity: retain port 6389.' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'fixture-checkpoint' } })
    const event = { type: 'user/message', seq: 1, time: 10, data: message, surfaceOp: 'append' } as SessionEvent
    expect(sessionEventToMemoryInput('test', event, 8000)).toBeUndefined()
    expect(messageToCompactionEntry(message, 10)?.content).toContain('6389')
    const polluted = { ...message, content: [{ type: 'text' as const, text: '<memory-context source="old">feedback</memory-context>' }] }
    expect(messageToCompactionEntry(polluted, 10)).toBeUndefined()
  })
  it.each([PLUGIN_ID, '@deepseek-ai/dsh-system-prompt', 'compact', 'third-party-context'])('does not ingest or summarize %s injections', plugin => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'Current runtime context. <memory-context source="remi-v0.2">old fact</memory-context>' }], source: { kind: 'plugin', plugin, form: 'runtime-context' } })
    const event = { type: 'user/message', seq: 1, time: 10, data: message, surfaceOp: 'append' } as SessionEvent
    expect(sessionEventToMemoryInput('test', event, 8000)).toBeUndefined()
    expect(messageToCompactionEntry(message, 10)).toBeUndefined()
    expect(extractQuery([message])).toBe('')
  })

  it('retains a real user quoting memory markup', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'Please explain <memory-context source="example">quoted</memory-context>' }], source: { kind: 'user' } })
    const event = { type: 'user/message', seq: 1, time: 10, data: message, surfaceOp: 'append' } as SessionEvent
    expect(sessionEventToMemoryInput('test', event, 8000)?.content).toContain('quoted')
    expect(messageToCompactionEntry(message, 10)?.content).toContain('quoted')
  })
})
