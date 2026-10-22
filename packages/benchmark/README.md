# @dsh-memory/benchmark

JSONL benchmark runner for retrieval traces and feature ablations. Use optional `primingQueries` to build co-activation graph state before the measured query. The runner includes an independent `no_hebbian` condition and reports graph read, application, boost, and reinforcement counts. The current string-evidence hit rate is a pipeline check, not a publication-quality evaluation.

## Paired validation framework

The development branch adds `src/validation.ts`, `src/dsh-meter.ts`, `src/validation-cli.ts` and `scripts/run-paired-validation.mjs`. They freeze a corpus before model execution, compare full/no-plugin/compaction-only/no-Hebbian/no-affect runs, preserve strict JSON scoring and refuse cost conclusions without complete paired usage and supplied prices. The independent meter belongs in every arm. Full mode keeps both core features enabled. See [local instructions](../../docs/FRAMEWORK_V0.4.zh-CN.md) and [exact evidence gaps](../../docs/AUDIT_2026-10-22.zh-CN.md).
