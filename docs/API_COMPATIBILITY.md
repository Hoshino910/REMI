# DeepSeek Harness API compatibility record

Verified on 2026-09-14 against official repository commit:

```text
repository: https://github.com/deepseek-ai/deepseek-harness
commit: c291e7961a515f6d7af9304e7fd1d257929aef26
commit date: 2026-09-10T22:17:09+08:00
source package version: 0.1.5-rc.2
npm package set used for local build: 0.1.5-rc.2
```

## Confirmed contracts

| Capability | Current contract | Adapter use |
|---|---|---|
| Session observer | `session/event(this: Scoped<Session>, session: Session, event: SessionEvent): void` | Ingests live durable message events into SQLite. |
| Pre-step interception | Waterfall `(payload, next) => Promise<PreStepDecision>`; payload includes `agent`, `messages`, `turn`, `step`, `signal` | Awaits downstream, preserves its decision, prepends one official user message when retrieval selects items. |
| Message constructor | `createUserMessage({ content, source })` generates identity and freezes the message | Creates recall with `{ kind: 'plugin', plugin: 'dsh-selective-memory', form: 'recall' }`. |
| Stable system prompt | `ctx.systemPrompt.section({ name, order, text })` | Adds one static policy at order `450`. |
| Compaction seam | `CompactionEngine` exposes `compactIfNeeded`, `compactNow`, `compactRegion` | Provided indirectly by subclassing the official basic backend. |
| Default compaction extension point | `BasicCompactionEngine` keeps the transaction fixed and exposes protected `summarize()` | Replaced by deterministic `core.compact()` output. |
| Surface replacement | Summary is a separate `user/message` with `surfaceOp: { op: 'replace', startSeq, endSeq }`; raw history remains in the log | Owned entirely by the official basic backend. |
| Token pressure | `ctx.tokenMeter.measure(session)` and routed model context capacity | Owned entirely by the official basic backend. |

## Primary sources

- [Agent events and `PreStepDecision`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/agent/src/runtime-types.ts)
- [Session service and `session/event`](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/session/src/index.ts)
- [Message constructors](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm/src/message.ts)
- [System prompt registry](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/core/system-prompt/src/index.ts)
- [Compaction service seam](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/compaction/compaction/src/index.ts)
- [Official basic compaction backend](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/compaction/compaction-basic/src/index.ts)
- [Official compaction transaction](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/compaction/compaction-basic/src/region.ts)
- [Cordis plugin primer](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/cordis-primer.md)

## Upgrade checklist

Before changing the DSH dependency range:

1. Confirm the seven contracts above in the new official source.
2. Confirm `BasicCompactionEngine.summarize()` remains protected and structurally compatible.
3. Confirm the preset still isolates `compaction` in a Cordis group.
4. Run `pnpm install`, `pnpm build`, `pnpm typecheck`, and `pnpm exec vitest run`.
5. Start one Harness test profile, observe a user event in SQLite, trigger one recall, and run `/compact`.
6. Inspect the durable log for one balanced `compaction/start` → `compaction/summary` → replacement `user/message` → `compaction/end` transaction.
