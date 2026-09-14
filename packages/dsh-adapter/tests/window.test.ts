import { describe, expect, it } from 'vitest'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  TRANSPARENT_WINDOW_CONTEXT_NAME,
  withTransparentMemoryWindow,
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
  it('replaces its own context without stacking and preserves other providers', () => {
    const result = withTransparentMemoryWindow(assembly(), 'new window')
    expect(result.contexts).toEqual([
      { name: 'other-plugin', text: 'keep me' },
      { name: TRANSPARENT_WINDOW_CONTEXT_NAME, text: 'new window' },
    ])
  })
})
