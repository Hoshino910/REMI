# DeepSeek Harness example

The two files target different composition shapes:

- `cordis.yml` is the current 0.1.5 agent-preset compaction group. Copy it into a custom preset in place of the existing group.
- `cordis.patch.yml` is only for a profile whose default backend is a root row named `compaction-basic`.

Do not mount this plugin beside another `ctx.compaction` provider in the same Cordis realm. The current official presets isolate both `compaction` and `toolResultPruner`, so the replacement plugin, `/compact` command, and pruner remain inside one group while `tokenMeter`, `sessions`, `llm`, and `systemPrompt` resolve from the host/scoped parent.

Use absolute paths in a patch file. DeepSeek Harness resolves a patch independently from the current profile directory.
