import { describe, expect, it } from 'vitest'
import { runBenchmark } from '../src/index.js'

describe('runBenchmark', () => {
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
