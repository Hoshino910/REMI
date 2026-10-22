import { describe, expect, it } from 'vitest'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  TRANSPARENT_WINDOW_CONTEXT_NAME,
  withTransparentMemoryWindow,
  withoutTransparentMemoryWindow,
} from '../src/window.js'

function assembly(): PromptAssembly {
  return {
    sections: [],
    contexts: [
      { name: 'other-plugin', text: 'keep me' },
      { name: TRANSPARENT_WINDOW_CONTEXT_NAME, text: 'old window' },
    ],
    tools: [],
    variables: {},
  }
}

describe('transparent memory window', () => {
  it('removes its stale contribution when retrieval is disabled or unavailable', () => {
    expect(withoutTransparentMemoryWindow(assembly()).contexts).toEqual([{ name: 'other-plugin', text: 'keep me' }])
  })
  it('replaces its own context without stacking and preserves other providers', () => {
    const result = withTransparentMemoryWindow(assembly(), 'new window')
    expect(result.contexts).toEqual([
      { name: 'other-plugin', text: 'keep me' },
      { name: TRANSPARENT_WINDOW_CONTEXT_NAME, text: 'new window' },
    ])
  })
  it('clears a stale window on an empty retrieval and stays singular across repeated assemblies', () => {
    let current = assembly()
    for (let i = 0; i < 100; i += 1) current = withTransparentMemoryWindow(current, `window-${i}`)
    expect(current.contexts.filter(context => context.name === TRANSPARENT_WINDOW_CONTEXT_NAME)).toHaveLength(1)
    current = withTransparentMemoryWindow(current, '')
    expect(current.contexts.find(context => context.name === TRANSPARENT_WINDOW_CONTEXT_NAME)?.text).toBe('')
    expect(current.contexts.some(context => context.text.includes('window-99'))).toBe(false)
    expect(current.contexts.find(context => context.name === 'other-plugin')?.text).toBe('keep me')
  })
})
