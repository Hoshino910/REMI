#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runBenchmark, type BenchmarkCase } from './index.js'

function loadCases(filename: string): BenchmarkCase[] {
  return readFileSync(filename, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as BenchmarkCase
      } catch (error: unknown) {
        throw new Error(`invalid JSONL at line ${index + 1}`, { cause: error })
      }
    })
}

const input = process.argv[2]
if (input === undefined) {
  console.error('Usage: dsh-memory-benchmark <dataset.jsonl>')
  process.exitCode = 1
} else {
  const report = await runBenchmark(loadCases(resolve(input)))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
