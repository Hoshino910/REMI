import { describe, it, expect } from 'vitest'
import { createValidationPlan, assertPlan, evaluateValidation, priceCall, scoreAnswer, type ValidationRun } from '../src/validation.js'

describe('frozen paired evidence evaluation', () => {
  it('freezes deterministic corpora and rejects edits after preparation', () => {
    const plan = createValidationPlan({ seeds: 2, interferenceTurns: 2 })
    expect(plan.corpusSha256).toBe(createValidationPlan({ seeds: 2, interferenceTurns: 2 }).corpusSha256)
    plan.cases[0]!.steps[0]!.text = 'changed'
    expect(() => assertPlan(plan)).toThrow('digest')
  })
  it('uses a predeclared strict output schema', () => {
    expect(scoreAnswer('{"value":"8247"}', '8247')).toBe(true)
    expect(scoreAnswer('{"port":"8247"}', '8247')).toBe(false)
    expect(scoreAnswer('{"value":null}', null)).toBe(true)
    expect(scoreAnswer('```json\n{"value":"8247"}\n```', '8247')).toBe(false)
  })
  it('prices disjoint DSH cache buckets and refuses unpriced cache use', () => {
    const call = { callId: '1', provider: 'p', model: 'm', stage: 'affect' as const, inputTokens: 100, cacheReadTokens: 200, outputTokens: 10 }
    const card = { currency: 'USD', sourceUrl: 'https://example.test/prices', effectiveAt: '2026-10-22', inputPerMillion: 2, outputPerMillion: 4 }
    expect(priceCall(call, { 'p/m': card })).toBeNull()
    expect(priceCall(call, { 'p/m': { ...card, cacheReadPerMillion: 1 } })).toBeCloseTo(0.00044)
  })
  it('cannot promote absent model runs into a successful report', () => {
    const report = evaluateValidation(createValidationPlan(), [])
    expect(report.comparisons.every(item => item.status === 'insufficient-evidence')).toBe(true)
  })
  it('counts failed/missing answers as failures and rejects duplicated runs', () => {
    const plan = createValidationPlan({ seeds: 1, repetitions: 1, interferenceTurns: 1 })
    const run: ValidationRun = { variant: 'full', seed: 0, repetition: 0, corpusSha256: plan.corpusSha256,
      modelConfigSha256: 'model', status: 'complete', answers: [], calls: [], providerUsageReconciled: false, heldoutSurfaceVerified: false }
    expect(evaluateValidation(plan, [run]).runs[0]?.accuracy).toBe(0)
    expect(() => evaluateValidation(plan, [run, run])).toThrow('Duplicate')
  })
  it('passes only complete matched synthetic evidence and fails when quality is sacrificed', () => {
    // Synthetic accounting fixtures test the gate; these are not real model results.
    const plan = createValidationPlan({ interferenceTurns: 1 })
    const runs: ValidationRun[] = []
    for (const testCase of plan.cases) for (let repetition = 0; repetition < plan.repetitions; repetition += 1) for (const variant of plan.variants) {
      runs.push({ variant, seed: testCase.seed, repetition, corpusSha256: plan.corpusSha256, modelConfigSha256: 'a'.repeat(64),
        status: 'complete', providerUsageReconciled: true, heldoutSurfaceVerified: true,
        answers: testCase.steps.filter(step => step.kind === 'prompt').map(step => ({ stepId: step.id,
          answer: Object.hasOwn(step, 'expected') ? JSON.stringify({ value: step.expected }) : 'ACK' })),
        calls: testCase.steps.filter(step => step.kind === 'prompt').map(step => ({ callId: `${variant}/${testCase.seed}/${repetition}/${step.id}`,
          provider: 'p', model: 'm', stage: 'answer', inputTokens: variant === 'full' ? 100 : 200, outputTokens: 10 })),
      })
    }
    const prices = { 'p/m': { currency: 'USD', sourceUrl: 'https://example.test/synthetic-only', effectiveAt: '2026-10-22', inputPerMillion: 1, outputPerMillion: 1 } }
    expect(evaluateValidation(plan, runs, prices).comparisons[0]?.status).toBe('pass')
    const degraded = runs.map(run => run.variant !== 'full' ? run : { ...run, answers: run.answers.map(answer => answer.stepId === 'after' ? { ...answer, answer: '{"value":null}' } : answer) })
    expect(evaluateValidation(plan, degraded, prices).comparisons[0]?.qualityGate).toBe(false)
    expect(evaluateValidation(plan, degraded, prices).comparisons[0]?.status).toBe('fail')
  })
})
