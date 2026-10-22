/** Independent metadata-only observer: install in ALL variants, including no-plugin. */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

export const name = 'remi-validation-meter'
export const inject = ['llm']
export interface Config { outputPath?: string }

export function apply(ctx: Context, config: Config = {}): void {
  const filename = resolve(config.outputPath ?? '.dsh-memory/validation-calls.jsonl')
  mkdirSync(dirname(filename), { recursive: true })
  ctx.on('llm/stream', async function* (options, next): AsyncIterable<StreamChunk> {
    const callId = randomUUID()
    const started = Date.now()
    let usage: TokenUsage | undefined
    let usageEvents = 0
    let finish = 'incomplete'
    // The bounded affect input is marked by REMI's own plugin source metadata.
    const affect = options.messages.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'dsh-selective-memory' && 'summary' in message.source
      && message.source.summary === 'Bounded affect classification input')
    const stage = affect ? 'affect' : options.purpose === 'compaction' ? 'compaction'
      : options.purpose === 'session-title' ? 'other' : 'answer'
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') { usage = chunk.usage; usageEvents += 1 }
        if (chunk.type === 'finish') finish = chunk.reason.kind
        yield chunk
      }
    } finally {
      appendFileSync(filename, JSON.stringify({ schemaVersion: 1, callId, sessionId: options.sessionId ?? null,
        modelConfigSha256: createHash('sha256').update(JSON.stringify({ provider: options.provider, model: options.model,
          temperature: options.temperature ?? null, maxTokens: options.maxTokens ?? null, reasoningEffort: options.reasoningEffort ?? null })).digest('hex'),
        provider: options.provider, model: options.model, stage, startedAt: started,
        durationMs: Date.now() - started, finish, usageEvents,
        // Ambiguous cumulative/delta streams need provider reconciliation, never guessed addition.
        usage: usageEvents === 1 ? usage : null,
        coverage: 'observed-llm-stream-only', providerUsageReconciled: false }) + '\n', { mode: 0o600 })
    }
  })
}

export default { name, inject, apply }
