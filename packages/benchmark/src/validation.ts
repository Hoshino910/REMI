import { createHash } from 'node:crypto'

export const VALIDATION_VARIANTS = ['full', 'no_plugin', 'compaction_only', 'no_hebbian', 'no_affect'] as const
export type ValidationVariant = typeof VALIDATION_VARIANTS[number]

export interface ValidationStep {
  id: string
  kind: 'prompt' | 'compact'
  text?: string
  expected?: string | null
  phase: 'write' | 'interference' | 'recall-before' | 'compact' | 'recall-after' | 'unknown'
}
export interface ValidationPlan {
  schemaVersion: 1
  protocol: 'remi-paired-v1'
  corpusSha256: string
  baseCommit: string
  seeds: number
  repetitions: number
  variants: readonly ValidationVariant[]
  cases: Array<{ seed: number; steps: ValidationStep[] }>
  thresholds: { minimumSeeds: number; minimumRepetitions: number; minimumAccuracy: number; maximumAccuracyLoss: number; minimumCostReduction: number }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const mean = (values: readonly number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
const THRESHOLDS = { minimumSeeds: 30, minimumRepetitions: 3, minimumAccuracy: 0.95, maximumAccuracyLoss: 0.02, minimumCostReduction: 0.20 }

/** Freeze before contacting any provider; token estimates never enter billing metrics. */
export function createValidationPlan(options: { seeds?: number; repetitions?: number; interferenceTurns?: number; baseCommit?: string } = {}): ValidationPlan {
  const seeds = options.seeds ?? 30
  const repetitions = options.repetitions ?? 3
  const interferenceTurns = options.interferenceTurns ?? 24
  for (const value of [seeds, repetitions, interferenceTurns]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Plan sizes must be positive integers')
  const cases: ValidationPlan['cases'] = []
  for (let seed = 0; seed < seeds; seed += 1) {
    const entity = `Cedar${seed}`
    const value = `seal-${(seed * 7919 + 104729).toString(36)}`
    const heldoutValue = `mark-${(seed * 6151 + 99991).toString(36)}`
    const steps: ValidationStep[] = [{ id: 'write', kind: 'prompt', phase: 'write',
      text: `The ${entity} deployment seal is ${value}. Reply only ACK.` },
      { id: 'write-heldout', kind: 'prompt', phase: 'write', text: `The Orion${seed} deployment seal is ${heldoutValue}. Reply only ACK.` }]
    for (let round = 0; round < interferenceTurns; round += 1) {
      steps.push({ id: `noise-${round}`, kind: 'prompt', phase: 'interference', text:
        `Unrelated archive ${seed}-${round}. ` + 'Notes about pottery, bread, music, weather, bicycles and gardening. '.repeat(20) + ' Reply only ACK.' })
    }
    const question = `What is the ${entity} deployment seal? Reply ONLY JSON with exactly one key: {"value":"..."}. If unknown use {"value":null}.`
    steps.push({ id: 'before', kind: 'prompt', phase: 'recall-before', text: question, expected: value })
    // Repeated compression is intentional; every variant receives the same schedule.
    steps.push({ id: 'compact-1', kind: 'compact', phase: 'compact' })
    for (let round = 0; round < 4; round += 1) steps.push({ id: `between-compactions-${round}`, kind: 'prompt', phase: 'interference',
      text: `Additional archive ${seed}-${round}. ` + 'Notes about ceramics, seasons, recipes and bicycles. '.repeat(30) + 'Reply only ACK.' })
    steps.push({ id: 'compact-2', kind: 'compact', phase: 'compact' })
    steps.push({ id: 'after', kind: 'prompt', phase: 'recall-after',
      text: `What is the Orion${seed} deployment seal? Reply ONLY JSON with exactly one key: {"value":"..."}. If unknown use {"value":null}.`, expected: heldoutValue })
    steps.push({ id: 'unknown', kind: 'prompt', phase: 'unknown',
      text: `What is the Birch${seed} deployment seal? Reply ONLY JSON with exactly one key: {"value":null} if unknown.`, expected: null })
    cases.push({ seed, steps })
  }
  return { schemaVersion: 1, protocol: 'remi-paired-v1', corpusSha256: digest(cases),
    baseCommit: options.baseCommit ?? 'unrecorded', seeds, repetitions, variants: VALIDATION_VARIANTS, cases,
    thresholds: { ...THRESHOLDS } }
}

export function assertPlan(plan: ValidationPlan): void {
  if (plan.schemaVersion !== 1 || plan.protocol !== 'remi-paired-v1' || digest(plan.cases) !== plan.corpusSha256) throw new Error('Plan schema or frozen corpus digest mismatch')
  if (new Set(plan.cases.map(item => item.seed)).size !== plan.cases.length || plan.cases.length !== plan.seeds) throw new Error('Duplicate or missing plan seeds')
  if (JSON.stringify(plan.variants) !== JSON.stringify(VALIDATION_VARIANTS)) throw new Error('Unexpected validation variants')
  if (JSON.stringify(plan.thresholds) !== JSON.stringify(THRESHOLDS)) throw new Error('Protocol thresholds differ from the frozen version')
}

export function scoreAnswer(answer: string, expected: string | null): boolean {
  try {
    const value: unknown = JSON.parse(answer)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 1 && Object.hasOwn(value, 'value')
      && (value as { value: unknown }).value === expected
  } catch { return false }
}

export interface UsageCall {
  callId: string
  provider: string
  model: string
  /** DSH rc.2 counters are disjoint: uncached input excludes both cache buckets. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  stage: 'answer' | 'affect' | 'compaction' | 'other'
}
export interface PriceCard {
  currency: string
  sourceUrl: string
  effectiveAt: string
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
}
export interface ValidationRun {
  variant: ValidationVariant
  seed: number
  repetition: number
  corpusSha256: string
  /** Same host/model/temperature/max-output config fingerprint across paired variants. */
  modelConfigSha256: string
  status: 'complete' | 'failed'
  answers: Array<{ stepId: string; answer: string }>
  calls: UsageCall[]
  /** Required reconciliation with provider records, including retries and auxiliary calls. */
  providerUsageReconciled: boolean
  /** For compressed variants, held-out answer absent from the active host surface before query. */
  heldoutSurfaceVerified: boolean
}

export function priceCall(call: UsageCall, prices: Readonly<Record<string, PriceCard>>): number | null {
  const card = prices[`${call.provider}/${call.model}`]
  if (!card || !card.currency || !card.sourceUrl || !card.effectiveAt) return null
  const terms = [
    [call.inputTokens, card.inputPerMillion], [call.outputTokens, card.outputPerMillion],
    [call.cacheReadTokens ?? 0, card.cacheReadPerMillion], [call.cacheWriteTokens ?? 0, card.cacheWritePerMillion],
  ] as const
  let cost = 0
  for (const [tokens, price] of terms) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) return null
    if (tokens === 0) continue
    if (price === undefined || !Number.isFinite(price) || price < 0) return null
    cost += tokens * price / 1_000_000
  }
  return cost
}

/** Seed-cluster bootstrap: repetitions do not count as independent samples. */
export function confidenceInterval(values: readonly number[]): readonly [number, number] | null {
  if (values.length < 2) return null
  let state = 104729
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
  const samples = Array.from({ length: 2_000 }, () => mean(values.map(() => values[Math.floor(random() * values.length)]!))).sort((a, b) => a - b)
  return [samples[49]!, samples[1949]!]
}

export function evaluateValidation(plan: ValidationPlan, runs: readonly ValidationRun[], prices: Readonly<Record<string, PriceCard>> = {}) {
  assertPlan(plan)
  const seen = new Set<string>()
  const configs = new Set(runs.map(run => run.modelConfigSha256))
  const callIds = new Set<string>()
  const scored = runs.map(run => {
    const key = `${run.variant}/${run.seed}/${run.repetition}`
    if (seen.has(key)) throw new Error(`Duplicate validation run: ${key}`)
    seen.add(key)
    if (!plan.variants.includes(run.variant) || !Number.isSafeInteger(run.repetition) || run.repetition < 0 || run.repetition >= plan.repetitions) throw new Error('Unexpected validation run')
    if (run.corpusSha256 !== plan.corpusSha256) throw new Error('Run corpus digest differs from frozen plan')
    const testCase = plan.cases.find(item => item.seed === run.seed)
    if (!testCase) throw new Error('Unknown seed')
    const answerIds = run.answers.map(answer => answer.stepId)
    if (new Set(answerIds).size !== answerIds.length || answerIds.some(id => !testCase.steps.some(step => step.kind === 'prompt' && step.id === id))) throw new Error('Duplicate or unknown answer step')
    const expected = testCase.steps.filter(step => Object.hasOwn(step, 'expected'))
    const accuracy = mean(expected.map(step => scoreAnswer(run.answers.find(answer => answer.stepId === step.id)?.answer ?? '', step.expected!) ? 1 : 0))
    for (const call of run.calls) {
      if (!call.callId || callIds.has(call.callId)) throw new Error('Missing or duplicated model call ID')
      callIds.add(call.callId)
    }
    const costs = run.calls.map(call => priceCall(call, prices))
    const promptCount = testCase.steps.filter(step => step.kind === 'prompt').length
    const complete = run.status === 'complete' && run.providerUsageReconciled === true && run.calls.length > 0
      && run.answers.length === promptCount && run.calls.filter(call => call.stage === 'answer').length >= promptCount
      && (run.variant === 'no_plugin' || run.heldoutSurfaceVerified === true)
      && costs.every(cost => cost !== null)
    return { ...run, accuracy, cost: complete ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) : null }
  })
  const currencies = new Set(scored.flatMap(run => run.calls.map(call => prices[`${call.provider}/${call.model}`]?.currency).filter(Boolean)))
  const controls = ['no_plugin', 'compaction_only', 'no_hebbian', 'no_affect'] as const
  const comparisons = controls.map(control => {
    const seedSavings: number[] = []
    const accuracyDifferences: number[] = []
    let pairedRuns = 0
    for (const testCase of plan.cases) {
      const savings: number[] = []
      const differences: number[] = []
      for (let repetition = 0; repetition < plan.repetitions; repetition += 1) {
        const find = (variant: ValidationVariant) => scored.find(run => run.seed === testCase.seed && run.repetition === repetition && run.variant === variant)
        const full = find('full'); const baseline = find(control)
        if (!full || !baseline || full.cost === null || baseline.cost === null || baseline.cost <= 0 || full.status !== 'complete' || baseline.status !== 'complete') continue
        savings.push(1 - full.cost / baseline.cost)
        differences.push(full.accuracy - baseline.accuracy)
        pairedRuns += 1
      }
      if (savings.length === plan.repetitions) { seedSavings.push(mean(savings)); accuracyDifferences.push(mean(differences)) }
    }
    const ci = confidenceInterval(seedSavings)
    const qualityCi = confidenceInterval(accuracyDifferences)
    const complete = seedSavings.length === plan.seeds && seedSavings.length >= plan.thresholds.minimumSeeds
      && plan.repetitions >= plan.thresholds.minimumRepetitions && configs.size === 1
      && [...configs].every(value => /^[a-f0-9]{64}$/.test(value)) && currencies.size === 1
    const fullAccuracy = mean(scored.filter(run => run.variant === 'full').map(run => run.accuracy))
    const costGate = complete && ci !== null && ci[0] > 0 && mean(seedSavings) >= plan.thresholds.minimumCostReduction
    const qualityGate = complete && fullAccuracy >= plan.thresholds.minimumAccuracy && qualityCi !== null
      && qualityCi[0] >= -plan.thresholds.maximumAccuracyLoss
    return { control, pairedRuns, independentSeeds: seedSavings.length, meanCostReduction: seedSavings.length ? mean(seedSavings) : null,
      costReduction95CI: ci, meanAccuracyDifference: accuracyDifferences.length ? mean(accuracyDifferences) : null,
      accuracyDifference95CI: qualityCi,
      status: !complete ? 'insufficient-evidence' : costGate && qualityGate ? 'pass' : 'fail',
      // Ablations are mechanism diagnostics; "pass" here uses the same stringent joint gate and is not required for release.
      costGate, qualityGate }
  })
  return { schemaVersion: 1, protocol: plan.protocol, corpusSha256: plan.corpusSha256,
    billingEvidence: 'provider-counters-and-supplied-price-cards', runs: scored.map(({ calls: _calls, answers: _answers, ...run }) => run), comparisons,
    note: 'No result proves cost reduction unless usage is reconciled, price cards supplied, all pairs complete and quality gates pass.' }
}
