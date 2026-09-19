# Changelog

## v0.2.1 - 2026-09-19

### Changed

- Added content-aware retrieval (`content-aware-v1`) with a scoring-only normalized view, corpus-IDF lexical evidence, query coverage gating, and lower utility for questions and acknowledgement messages.
- Prevented questions from becoming Hebbian graph seeds or reinforcement targets in content-aware mode.
- Quarantined plugin-generated context, skill catalogs, and agent instructions before the SQLite candidate limit; original records remain available for audit.
- Excluded generated runtime-memory snapshots from observation and compaction while allowing clean official continuity checkpoints to be re-compacted.
- Resolved the compaction backend from the running packaged DSH Desktop host, preferring `app.asar` over potentially stale unpacked resources. Non-Desktop installations continue to use the installed peer package.
- Added retrieval scoring metadata to `RetrievalTrace` and benchmark output.
- Added a deterministic 96-round long-dialogue fixture, clean-SQLite guard, DSH execution driver, strict JSON field scorer, and read-only full-run auditor.

### Validation

- 31 unit and regression tests pass, together with build and typecheck.
- A new-session, new-database DSH Desktop run completed 114 model turns and 96 interference rounds without retry or tool-call events.
- `/compact` replaced 323 history items. Four held-out facts were absent from the active surface and were later selected at rank 1 and delivered through fresh memory windows.
- Human content review found all 8 pre-compaction and all 8 post-compaction fields present. The frozen strict scorer reported 3/8 and 2/8 because the model used unregistered JSON aliases, a generic suffix, and split schedule fields. Both measurements are retained; the human review is not presented as an automatic benchmark score.

See [docs/V0.2.1_VALIDATION.md](docs/V0.2.1_VALIDATION.md) for scope and limitations.

### Known limitations

- Early testing only; not production-ready.
- The token budget bounds only the REMI memory contribution, not the full model request.
- No validated cross-session memory, fact supersession/deletion lifecycle, provider-independent semantic embedding, or demonstrated cost reduction.
- Hebbian and affect components have not shown independent causal benefit in controlled model ablations.
- DSH is a developer preview and may introduce breaking compatibility changes.
