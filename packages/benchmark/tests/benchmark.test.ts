import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runBenchmark } from '../src/index.js'

describe('runBenchmark', () => {
  it('keeps the frozen Current Truth v1 protocol structurally valid', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/current-truth-v1.json', import.meta.url), 'utf8')) as {
      protocolVersion: string
      cases: Array<{ id: string; messages: string[]; query: string; expected?: unknown; expectedHistory?: unknown; expectedUnknown?: boolean }>
    }
    expect(fixture.protocolVersion).toBe('current-truth-v1')
    expect(new Set(fixture.cases.map(item => item.id)).size).toBe(fixture.cases.length)
    expect(fixture.cases.map(item => item.id)).toEqual([
      'single-correction', 'history-request', 'multiple-corrections',
      'similar-entity-isolation', 'ambiguous-future-intent', 'unknown-entity',
    ])
    for (const item of fixture.cases) {
      expect(item.messages.length).toBeGreaterThan(0)
      expect(item.query.length).toBeGreaterThan(0)
      expect(Number(Boolean(item.expected)) + Number(Boolean(item.expectedHistory)) + Number(item.expectedUnknown === true)).toBe(1)
    }
  })
  it('emits stable ablation names and retrieval metrics', async () => {
    const report = await runBenchmark([{
      id: 'one',
      sessionId: 'bench-one',
      query: 'Which store is used?',
      tokenBudget: 200,
      relevantContentIncludes: ['SQLite'],
      memories: [
        { role: 'user', sourceType: 'user/message', content: 'Use SQLite for storage.', timestamp: 1 },
        { role: 'assistant', sourceType: 'assistant/message', content: 'The sky is blue.', timestamp: 2 },
      ],
      now: 3,
    }])
    expect(report.runs.map(run => run.ablation)).toEqual([
      'full', 'similarity_only', 'no_recency', 'no_importance',
    ])
    expect(report.runs[0]?.hitRateAtK).toBe(1)
  })
})
