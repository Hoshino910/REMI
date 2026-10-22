#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createValidationPlan, evaluateValidation, type ValidationPlan, type ValidationRun, type PriceCard } from './validation.js'

try {
  const [operation, ...args] = process.argv.slice(2)
  if (operation === 'plan') {
    const [seeds, repetitions, interferenceTurns] = args
    console.log(JSON.stringify(createValidationPlan({
      seeds: seeds === undefined ? 30 : Number(seeds), repetitions: repetitions === undefined ? 3 : Number(repetitions),
      interferenceTurns: interferenceTurns === undefined ? 24 : Number(interferenceTurns),
      baseCommit: process.env.REMI_BASE_COMMIT ?? 'unrecorded',
    }), null, 2))
  } else if (operation === 'score' && args[0] && args[1]) {
    const plan = JSON.parse(readFileSync(args[0], 'utf8')) as ValidationPlan
    const runs = JSON.parse(readFileSync(args[1], 'utf8')) as ValidationRun[]
    const prices = args[2] ? JSON.parse(readFileSync(args[2], 'utf8')) as Record<string, PriceCard> : {}
    console.log(JSON.stringify(evaluateValidation(plan, runs, prices), null, 2))
  } else throw new Error('Usage: validation-cli plan [seeds repetitions interferenceTurns] | score plan.json runs.json [prices.json]')
} catch (error: unknown) { console.error(error instanceof Error ? error.message : 'Validation failed'); process.exitCode = 1 }
