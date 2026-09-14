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

The same adapter was loaded by DSH Desktop 2.0.6 on Windows. Its health manifest reported Harness `0.1.2-rc.1` while packaged module metadata reported `0.1.2-alpha.1`, so the current official source remains the compile-time baseline and Desktop is treated as a compatibility smoke target.

An isolated headless run with a deterministic local `LlmAdapter` completed two Agent steps and returned `REMI_LIVE_OK`. The trace observed 7 ingested events, two model-sourced affect analyses, a 470-token runtime-context window under a 600-token budget, one reinforced association edge, and an automatic extractive compaction from 1766 estimated input tokens to 478 output tokens. On Windows, the packaged loader required the adapter name to use a `file:///C:/...` URL.

A separate attempt through the configured remote provider returned `TRANSPORT: Connection error`; REMI recorded the error, produced a heuristic fallback, and continued its observer path. This validates failure isolation, not remote-provider availability.

## Confirmed contracts

| Capability | Current contract | Adapter use |
|---|---|---|
| Session observer | `session/event(this: Scoped<Session>, session: Session, event: SessionEvent): void` | Ingests live durable message events into SQLite. |
| Inbox claim | `agent/inbox/claimed({ agent, message, turn })` fires synchronously before prompt assembly | Captures direct user text and turn id without mutating the inbox message. |
| Prompt assembly | Async `system-prompt/assemble(assembly, context, next)` waterfall; `AssembleContext.agent` is present for live agent calls | Retrieves after `next()` and adds one uniquely named `AssembledContext`. |
| Runtime-context projection | Assembly contexts are materialized as user-role runtime-context snapshots; the current snapshot supersedes earlier runtime-context snapshots on the active surface | Implements a bounded transparent memory window while retaining the durable audit log. |
| Stable system prompt | `ctx.systemPrompt.section({ name, order, text })` | Adds one static policy at order `450`. |
| Auxiliary model call | Direct `ctx.llm.stream(GenerateOptions)` with official message constructors and `BlockAssembler` | Optional structured affect classification; no training, and failure falls back locally. |
| Compaction seam | `CompactionEngine` exposes `compactIfNeeded`, `compactNow`, `compactRegion` | Provided indirectly by subclassing the official basic backend. |
| Default compaction extension point | `BasicCompactionEngine` keeps the transaction fixed and exposes protected `summarize()` | Replaced by deterministic `core.compact()` output. |
| Surface replacement | Summary is a separate `user/message` with `surfaceOp: { op: 'replace', startSeq, endSeq }`; raw history remains in the log | Owned entirely by the official basic backend. |
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
