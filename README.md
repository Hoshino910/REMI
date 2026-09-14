# REMI

> Adaptive Memory for AI — DeepSeek Harness selective-memory plugin v0.1

一个面向 **DeepSeek Harness** 的长期上下文原型插件。它不是 Web 应用，不训练模型，也不替换 Harness 的 Agent Loop；它通过 Harness 的公开 Cordis 扩展点观察会话、写入 SQLite、在模型调用前召回有限记忆，并用自定义 extractive checkpoint 替换过旧的模型可见历史。

当前版本只验证最小闭环：

```text
session/event ──> SQLite sidecar memory
                         │
agent/pre-step <── query + scoring + token budget
       │
       └──> one logged user-role recall message ──> model

token pressure ──> official compaction transaction
                         │
                         └──> deterministic continuity checkpoint
```

## 已实现

- `session/event` observer：观察 `user/message`、`assistant/message`、`tool/result`，忽略本插件自己的 recall 与 compaction checkpoint，按 `(session_id, source_event_seq)` 去重。
- SQLite store：使用 Node.js 内置 `node:sqlite`，启用 WAL、索引、访问计数和 retrieval trace 表，无原生第三方扩展。
- `agent/pre-step` retrieval injection：使用官方 `createUserMessage()`，以 `form: 'recall'` 注入，保留下游 `PreStepDecision`。
- custom compaction：继承官方 `BasicCompactionEngine`，复用它的 token pressure、锁、`compaction/start`/`summary`/`end` 事件、surface replacement、并发稳定性与手动 flush；只替换摘要策略。
- stable system prompt policy：固定静态段，不把每轮变化的检索内容放进 system prompt。
- telemetry：SQLite 保存完整 `RetrievalTrace`；JSONL 保存 ingest/retrieval/compaction/error 事件。JSONL 不保存原始 query 或记忆正文。
- benchmark：提供 `full`、`similarity_only`、`no_recency`、`no_importance` 四个基础消融入口。

v0.1 明确不包含 Hebbian 图、情绪模型、复杂 Ebbinghaus、远程 embedding 服务或模型训练。相似度是可替换占位实现：hashed bag-of-tokens embedding cosine + lexical Jaccard，再与简单 recency 和 importance 加权。

## 工程结构

```text
packages/
  core/             # 与 DeepSeek Harness 完全解耦的 MemoryRuntime、scoring、budget、trace
  store-sqlite/     # SQLite schema 与 MemoryStore 实现
  dsh-adapter/      # Cordis/DSH observer、pre-step、policy、compaction、telemetry
  benchmark/        # JSONL 数据集 runner 与 ablation
examples/
  deepseek-harness/ # 当前 preset 结构与旧式 root overlay 示例
  benchmark/        # 最小 benchmark 数据集
```

## API 核对基线

实现于 2026-09-14 对照 DeepSeek 官方仓库 `master` 提交 `c291e7961a515f6d7af9304e7fd1d257929aef26`，对应源码包版本 `0.1.5-rc.2`。精确核对记录见 [docs/API_COMPATIBILITY.md](docs/API_COMPATIBILITY.md)。

关键结论：

- `session/event` 是 `(session, event)` 的 observe-only emit；append 后 observer 失败会被 Harness 隔离。
- `agent/pre-step` 是 waterfall；合作型 listener 必须调用 `next()`，并保留下游的 `messages` 与 `startsRequestSeries`。
- model-visible recall 必须使用 logged channel，不能在 `agent/request` 修改 messages。
- `ctx.systemPrompt.section()` 适合稳定 policy；动态 context 会成为持久 user-role snapshot，因此不用于每轮 retrieval。
- `ctx.compaction` 是可替换 service seam；当前默认 backend 已实现复杂的 surface 事务约束。本项目继承该 backend 并覆写 protected `summarize()`，避免复制内部事务。

## 本地运行

要求 Node.js `^22.19.0 || >=24.0.0` 和 pnpm。仓库已锁定到 Harness `0.1.5-rc.2` 的 npm 包。

```powershell
pnpm install
pnpm build
pnpm typecheck
pnpm exec vitest run
pnpm benchmark
```

当前验证结果：4 个测试文件、7 个测试全部通过；所有包 build 与 typecheck 通过；示例 benchmark 四组消融均可运行。

## 接入 DeepSeek Harness

先在本仓库执行 `pnpm install` 与 `pnpm build`。然后把 [examples/deepseek-harness/cordis.yml](examples/deepseek-harness/cordis.yml) 中的 Windows 绝对路径替换为本机路径。

当前官方 `standard`/`ptc` preset 把 compaction 放在隔离的 `compaction` group 里。最稳妥的接法是复制一个自定义 agent preset，并用示例中的整个 group 替换默认 group；不要把第二个 `ctx.compaction` provider 直接挂到同一 realm。

如果使用仍在 root composition 中挂载 `id: compaction-basic` 的 profile，可使用 [examples/deepseek-harness/cordis.patch.yml](examples/deepseek-harness/cordis.patch.yml) 禁用默认 provider 后插入本插件：

```powershell
pnpm dsh web --patch C:/absolute/path/to/cordis.patch.yml
```

核心配置：

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `databasePath` | `.dsh-memory/memory.sqlite` | sidecar 数据库；生产环境建议绝对路径 |
| `telemetryPath` | `.dsh-memory/telemetry.jsonl` | 无原始 query/正文的 JSONL trace |
| `retrievalTokenBudget` | `1400` | 单步 recall 最大估算 token |
| `retrievalLimit` | `8` | 单步最多注入的记忆条数 |
| `minRetrievalScore` | `0.12` | 召回最低总分 |
| `similarityWeight` | `0.65` | hashed embedding + lexical 相似度权重 |
| `recencyWeight` | `0.20` | 简单时近性权重 |
| `importanceWeight` | `0.15` | 消息重要性权重 |
| `compactionSummaryTokenBudget` | `900` | extractive checkpoint 预算 |
| `compactionThresholdRatio` | `0.80` | 按官方 token meter 触发压缩的比例 |
| `compactionRetainRatio` | `0.16` | 保留的近期原文比例 |

数据库包含原始对话文本。请把数据库目录视为会话存储的一部分，使用与 Harness session store 相同或更严格的本地权限；不要把 SQLite 或 JSONL 提交到 Git。

## RetrievalTrace

每次 retrieval 都保留：

- query fingerprint 和字符数，而不是原始 query；
- candidate/selected 数量与 token budget；
- 每个候选的 embedding、lexical、recency、importance、final score；
- `selected`、`below-min-score`、`budget`、`limit` 决策；
- 耗时与最终注入 token 估算。

这些字段为后续论文 benchmark、feature ablation、continuity-vs-token 曲线预留。格式定义在 `packages/core/src/types.ts`，SQLite trace 可通过 `SqliteMemoryStore.listTraces()` 读取。

## Benchmark 数据格式

每行一个 JSON 对象：

```json
{
  "id": "case-id",
  "sessionId": "session-id",
  "memories": [
    {
      "sourceEventSeq": 1,
      "role": "user",
      "sourceType": "user/message",
      "content": "Use SQLite for storage.",
      "timestamp": 1789350000000,
      "importance": 0.9
    }
  ],
  "query": "Which store did we choose?",
  "relevantContentIncludes": ["SQLite"],
  "tokenBudget": 220
}
```

用自己的数据集运行：

```powershell
node packages/benchmark/dist/cli.js C:/path/to/dataset.jsonl
```

当前 `hitRateAtK` 是最小字符串证据检查，只用于保证实验管线闭环，不应被当成论文级质量指标。下一阶段应增加人工标注 continuity、事实准确率、误召回率、原始上下文 token、KV cache 与实际 provider usage。

## v0.1 限制

- 插件从安装后的 live `session/event` 开始观察。Harness 当前不会为 constructor seed 重发该事件，因此首次装入时不会自动回填已有旧 session；一旦写入 sidecar，后续重启会继续使用 SQLite 记忆。
- placeholder embedding 不等同于语义 embedding；跨语言、同义表达和复杂代码关系的效果有限。
- extractive compaction 不调用模型，成本稳定且可复现，但可能遗漏隐含决策或把过时文字保留下来。
- 没有冲突消解、superseded 状态、跨 session identity、删除/合规 API。
- token 是启发式估算；实际压力触发由 Harness 官方 `ctx.tokenMeter` 决定。
- DSH 仍在 pre-release。升级官方包前应重新执行 `docs/API_COMPATIBILITY.md` 中的检查。

### 本插件处于早期测试阶段，强烈建议不要加入到生产环境中
