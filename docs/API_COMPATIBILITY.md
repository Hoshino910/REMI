# DeepSeek Harness API compatibility record

Verified on 2026-09-14 against official repository commit:

```text
repository: https://github.com/deepseek-ai/deepseek-harness
commit: c291e7961a515f6d7af9304e7fd1d257929aef26
commit date: 2026-09-10T22:17:09+08:00
source package version: 0.1.5-rc.2
npm package set used for local build: 0.1.5-rc.2
```

## Packaged Desktop smoke test

### 2026-09-16 packaged-host verification

The running Windows DSH Desktop reported Desktop 2.0.6 / Harness `0.1.2-rc.1`. A stale `app.asar.unpacked` directory on the same installation contained an older Harness package whose surface replacement wire format differed from the running host. Loading the workspace development `BasicCompactionEngine` or that stale unpacked implementation caused transaction validation failures.

File-loaded plugins now resolve the basic compaction engine from the running Electron resources, preferring the virtual `app.asar` tree over `app.asar.unpacked`. Outside Electron, the installed peer remains the backend. A headless host can set `REMI_DSH_PACKAGE_ROOT` to the absolute package root that matches its session runtime; invalid explicit roots fail instead of silently selecting another implementation.

After restart, telemetry reported `desktop-host:0.1.2-rc.1`. The clean-store v0.2.1 run completed one live `/compact` transaction, replacing 323 history items, followed by four successful held-out recall turns. See [V0.2.1_VALIDATION.md](V0.2.1_VALIDATION.md). This verifies the recorded host only, not every Desktop or Harness version.

Both observer and summarizer exclude plugin/context/catalog provenance. The SQLite candidate view also excludes previously persisted plugin, skill-catalog, and agent-instructions records **before LIMIT**, without deleting audit records. Direct user/model/tool conversation remains eligible, and user-quoted markup is not excluded by text matching.

A clean official `compact` checkpoint carrying `compactionId` may enter a later summarization pass, but is never indexed as a new memory. Historical checkpoints containing runtime-memory windows are excluded.

## Confirmed contracts

| Capability | Current contract | Adapter use |
|---|---|---|
| Session observer | `session/event(this: Scoped<Session>, session: Session, event: SessionEvent): void` | Ingests live durable message events into SQLite. |
| Inbox claim | `agent/inbox/claimed({ agent, message, turn })` fires synchronously before prompt assembly | Captures direct user text and turn id without mutating the inbox message. |
| Prompt assembly | Async `system-prompt/assemble(assembly, context, next)` waterfall; `AssembleContext.agent` is present for live agent calls | Retrieves after `next()` and adds one uniquely named `AssembledContext`. |
| Runtime-context projection | Assembly contexts are materialized as user-role runtime-context snapshots; supersession depends on host projection, and append-only snapshots are not themselves history compaction | Adds a bounded contribution; does not guarantee a bounded complete request. Generated snapshots are excluded from memory/summary. |
| Stable system prompt | `ctx.systemPrompt.section({ name, order, text })` | Adds one static policy at order `450`. |
| Auxiliary model call | Direct `ctx.llm.stream(GenerateOptions)` with official message constructors and `BlockAssembler` | Optional structured affect classification; no training, and failure falls back locally. |
| Compaction seam | `CompactionEngine` exposes `compactIfNeeded`, `compactNow`, `compactRegion` | Provided indirectly by subclassing the official basic backend. |
| Default compaction extension point | `BasicCompactionEngine` keeps the transaction fixed and exposes protected `summarize()` | Replaced by deterministic `core.compact()` output. |
| Surface replacement | Summary is a separate `user/message` with a host-version-specific replace operation; raw history remains in the log | Owned entirely by the basic backend resolved from the running host. |
| Token pressure | `ctx.tokenMeter.measure(session)` and routed model context capacity | Owned entirely by the official basic backend. |

## Primary sources

- [Agent events and `PreStepDecision`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent/src/runtime-types.ts)
- [Agent inbox claim lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent-loop/src/inbox.ts)
- [Agent prompt assembly context](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent/src/dispatch.ts)
- [Session service and `session/event`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/session/src/index.ts)
- [Message constructors](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm/src/message.ts)
- [System prompt registry](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/system-prompt/src/index.ts)
- [Compaction service seam](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/compaction/compaction/src/index.ts)
- [Official basic compaction backend](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/compaction/compaction-basic/src/index.ts)
- [Official compaction transaction](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/compaction/compaction-basic/src/region.ts)
- [Cordis plugin primer](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/cordis-primer.md)

## Upgrade checklist

Before changing the DSH dependency range:

1. Confirm the observer, inbox, assembly, projection, auxiliary LLM, compaction, and token-meter contracts above in the new official source.
2. Confirm `BasicCompactionEngine.summarize()` remains protected and structurally compatible.
3. Confirm the preset still isolates `compaction` in a Cordis group.
4. Run `pnpm install`, `pnpm build`, `pnpm typecheck`, and `pnpm exec vitest run`.
5. Start one Harness test profile, observe a user event in SQLite, trigger one runtime-context memory window, and run `/compact`.
6. Inspect the durable log for one balanced `compaction/start` → `compaction/summary` → replacement `user/message` → `compaction/end` transaction.
