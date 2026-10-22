import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/dsh-meter.js'

describe('independent DSH usage observer', () => {
  it('forwards the stream and records metadata without prompts or responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remi-meter-'))
    try {
      let listener: ((options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>) | undefined
      const ctx = { on(_name: string, callback: typeof listener) { listener = callback } } as unknown as Context
      apply(ctx, { outputPath: join(dir, 'calls.jsonl') })
      const chunks: StreamChunk[] = [{ type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 5 } }, { type: 'finish', reason: { kind: 'stop' } }]
      const next = async function* () { yield* chunks }
      const options = { provider: 'provider', model: 'model', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'secret-test-body' }] }] } as GenerateOptions
      const output: StreamChunk[] = []
      for await (const chunk of listener!(options, next)) output.push(chunk)
      expect(output).toEqual(chunks)
      const raw = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      expect(raw).not.toContain('secret-test-body')
      expect(JSON.parse(raw)).toMatchObject({ usageEvents: 1, usage: { inputTokens: 100 }, providerUsageReconciled: false, stage: 'answer' })
      expect(JSON.parse(raw).modelConfigSha256).toMatch(/^[a-f0-9]{64}$/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
