import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { PLUGIN_ID } from './extract.js'

export const TRANSPARENT_WINDOW_CONTEXT_NAME = `${PLUGIN_ID}:transparent-window`

/**
 * Replace this plugin's prior contribution inside one assembly. DSH also
 * supersedes prior durable runtime-context snapshots between loop steps.
 */
export function withTransparentMemoryWindow(
  assembly: PromptAssembly,
  text: string,
): PromptAssembly {
  return {
    ...assembly,
    contexts: [
      ...assembly.contexts.filter(context => context.name !== TRANSPARENT_WINDOW_CONTEXT_NAME),
      { name: TRANSPARENT_WINDOW_CONTEXT_NAME, text },
    ],
  }
}
