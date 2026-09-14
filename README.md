# REMI

> Adaptive Memory for AI
> 面向 AI 的自适应记忆与上下文管理插件 · DeepSeek Harness · v0.1 研究原型

**REMI** 面向通用长时对话与 Agent 工作流，通过选择性记忆、上下文召回和历史压缩，控制每次模型请求携带的信息量。目标是在保留关键事实、约束与任务连续性的前提下，降低长上下文带来的 token 消耗。

REMI 以 **DeepSeek Harness 插件**交付，不需要训练或修改基础模型。当前实现通过 Harness 的公开 Cordis 扩展点观察会话、写入 SQLite、在模型调用前召回有限记忆，并用自定义 extractive checkpoint 替换较旧的模型可见历史。遗忘曲线、情绪辅助信号和可自定义的透明窗口构成后续技术方向，适用范围包括个人助手、知识问答、持续任务及其他长时交互。

**版本状态：**v0.1 已实现基础存储、时近性评分、预算召回和抽取式压缩；尚未实现情绪模型、访问强化的指数遗忘曲线和完整透明窗口调度。降低实际费用、保持回答质量和实现用户无感连续性，仍需端到端实验验证。品牌名称为 REMI；当前代码包名、插件标识和数据库路径沿用已有名称。

当前版本只验证最小闭环：

```mermaid
flowchart TD
    A["DSH 会话事件"] --> B["SQLite 记忆"]
    B --> C["查询评分与预算召回"]
    C --> D["已记录的模型可见上下文"]
    E["DSH 压缩事务"] --> D
```

召回通过正式会话消息进入请求；压缩事务从 DSH 当前历史生成 checkpoint，后续可通过 SQLite 召回被压缩区域的细节。

## 已实现

- `session/event` observer：观察 `user/message`、`assistant/message`、`tool/result`，忽略本插件自己的 recall 与 compaction checkpoint，按 `(session_id, source_event_seq)` 去重。
- SQLite store：使用 Node.js 内置 `node:sqlite`，启用 WAL、索引、访问计数和 retrieval trace 表，无原生第三方扩展。
- `agent/pre-step` retrieval injection：使用官方 `createUserMessage()`，以 `form: 'recall'` 注入，保留下游 `PreStepDecision`。
- custom compaction：继承官方 `BasicCompactionEngine`，复用它的 token pressure、锁、`compaction/start`/`summary`/`end` 事件、surface replacement、并发稳定性与手动 flush；只替换摘要策略。
- stable system prompt policy：固定静态段，不把每轮变化的检索内容放进 system prompt。
- telemetry：SQLite 保存完整 `RetrievalTrace`；JSONL 保存 ingest/retrieval/compaction/error 事件。JSONL 不保存原始 query 或记忆正文。
- benchmark：提供 `full`、`similarity_only`、`no_recency`、`no_importance` 四个基础消融入口。

v0.1 明确不包含 Hebbian 图、情绪模型、复杂 Ebbinghaus、远程 embedding 服务或模型训练。相似度是可替换占位实现：hashed bag-of-tokens embedding cosine + lexical Jaccard，再与简单 recency 和 importance 加权。

## 技术说明

### 遗忘曲线与记忆保留

REMI 将“遗忘”首先定义为**降低旧信息进入当前模型请求的优先级**。数据库里仍然存在的记录，可以暂时不进入上下文；物理删除则需要独立的数据生命周期机制。当前版本没有删除 API，也不按时间自动清空 SQLite。

**当前实现：时近性衰减。** `packages/core/src/runtime.ts` 使用下面的函数：

$$
R(t)=\frac{1}{1+t/h}
$$

其中，$t$ 是从记忆创建时间起经过的天数，$h$ 对应 `recencyHalfLifeDays`，默认 30 天。经过 30 天，时近性分量变为 0.5；经过 90 天，变为 0.25。这是双曲形式的工程启发式，不是已经复现的人类遗忘规律，也不是指数衰减。

默认召回总分为：

$$
S(m,q)=0.65\,\mathrm{Similarity}(m,q)+0.20\,R(t)+0.15\,\mathrm{Importance}(m)
$$

三项权重可配置，并在运行时归一化。衰减只影响时近性分量，相关或重要的旧记录仍有机会被召回。当前相似度由 hashed embedding cosine 与 lexical Jaccard 组合；重要性由角色和关键词启发式估计。系统记录 `lastAccessedAt` 与 `accessCount`，但当前评分使用 `createdAt`，**访问次数尚不改变遗忘速度**。

**后续设计：带强化的遗忘曲线。** 可将下式作为待验证候选：

$$
R_m(\Delta t)=\exp\left(-\lambda\frac{\Delta t}{s_m}\right)
$$

$\Delta t$ 表示距最近一次有效强化的时间，$s_m$ 表示记忆强度，$\lambda$ 控制衰减速度。后续拟让重复验证、明确反馈和有效使用调整强度；对用户明确约束与未完成任务设置独立保留规则。上述参数和策略尚未加入当前配置，不能把检索到一条记忆直接视为它已被证实。

### 情绪作为短期辅助信号

情绪模块的设计目的，是在通用交互中帮助识别某段经历对当前任务的显著性，例如用户反复表达的挫败、紧迫感或满意反馈。它不把推断出的情绪写成永久身份属性，也不让情绪覆盖事实、当前指令或用户明确约束。

**当前实现：尚未接入情绪模型。** 当前仓库的 `MemoryRecord`、召回评分和 DSH 配置没有专用情绪字段；`importance` 也不能被解释为情绪分数。下面是后续建议的数据表示，不是可直接启用的配置：

```json
{
  "valence": -0.2,
  "arousal": 0.7,
  "confidence": 0.6,
  "observedAt": "2026-09-14T08:00:00Z",
  "source": "external-observation"
}
```

- `valence`：效价，建议范围为 −1 到 1。
- `arousal`：唤醒程度，建议范围为 0 到 1。
- `confidence`：对该次观察的置信度；信息不足时允许 `unknown`，不强行赋值。
- `observedAt` 与 `source`：保留时间和来源，便于衰减、纠正与审计。

拟采用置信度加权的平滑更新：$E_t=wE_{obs}+(1-w)E_{t-1}$，其中 $w=\alpha\cdot confidence$。情绪状态需要单独随时间衰减；是否将其用于召回重排序或记忆强度，应通过消融实验决定。自动推断、跨语言校准、开关与持久化策略均尚未实现。

### 透明窗口与自定义上下文长度

**透明窗口**指用户持续在同一段交互中工作，插件在后台管理本轮交给模型的上下文：保留近期内容和任务状态，按需召回旧信息，并在预算不足时压缩历史。用户不需要手动分段、开新窗口或搬运摘要；存储的历史规模也不必等于每轮发送给模型的上下文规模。这里的“透明”是交互目标，开发者仍应能查看检索与压缩记录。

当前已经具备这一目标的部分基础：

| 层面 | v0.1 行为 | 边界 |
|---|---|---|
| 长期历史 | 按 session 写入 SQLite | 不自动回填安装前已有历史；没有默认跨会话共享 |
| 本轮召回 | 按查询评分、条数和估算 token 预算选取记忆 | 召回按分数排序，未使用 KadaneDial 连续片段算法 |
| 历史压缩 | 通过官方事务生成抽取式 continuity checkpoint | 压缩所选条目恢复原始顺序，但可能遗漏细节或保留过时信息 |
| 稳定前缀 | 固定记忆 policy，动态召回进入普通会话消息 | 不承诺实际 KV cache 命中率 |
| 可观察性 | RetrievalTrace 与压缩 telemetry | 不等于用户体验或回答质量已得到保证 |

**当前可调的长度参数：**

| 配置 | 默认值 | 调整对象 |
|---|---:|---|
| `retrievalTokenBudget` | 1400 | 一次召回的估算 token 预算 |
| `retrievalLimit` | 8 | 一次召回的条目数上限 |
| `compactionSummaryTokenBudget` | 900 | continuity checkpoint 的估算预算 |
| `compactionThresholdRatio` | 0.80 | 相对模型上下文容量的压缩触发比例 |
| `compactionRetainRatio` | 0.16 | 官方压缩策略保留近期上下文的比例 |

这些参数作用于不同环节，**还不是统一的“整轮输入 token 硬上限”**。召回与 checkpoint 使用启发式估算，消息包装和其他请求内容也会占用 token；实际压力判断由 DSH `ctx.tokenMeter` 负责。增大预算可能保留更多信息，也可能增加成本；减小预算需要检查关键事实与任务连续性，不能保证任意长度都可无损。

例如，以下字段可以放入已有插件行的 `config`，其他挂载配置继续使用本仓库示例：

```yaml
retrievalTokenBudget: 2000
retrievalLimit: 8
compactionSummaryTokenBudget: 1200
compactionThresholdRatio: 0.70
compactionRetainRatio: 0.20
```

**后续完整窗口调度：**拟提供可自定义的整轮输入预算，统一核算稳定提示、工具声明、近期消息、checkpoint 与召回内容，并为模型输出预留空间。若关键约束或不可拆分的工具调用单元超过预算，应明确报告无法满足，而不是静默丢弃。查询相关连续分块、重要约束保护和真实 token 核算仍需要进一步实现。

### 三者如何协作

遗忘曲线控制历史信息随时间变化的保留倾向；情绪在有来源和置信度时提供可选显著性信号；透明窗口负责在本轮预算下组装上下文。最终仍需综合相关性、事实时效、明确约束与任务状态作出选择。

验证时应分别比较“仅检索”“加入衰减”“加入情绪”“加入窗口调度”，并同时记录关键事实召回、冲突与过时信息、任务连续性、实际输入和输出 token、附加模型调用成本及延迟。现有示例消融只覆盖相似度、时近性和重要性，不包含情绪或完整遗忘曲线实验。

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

以下为仓库既有核对记录，本次 README 更新没有重新验证上游最新版。

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

仓库已有验证记录：4 个测试文件、7 个测试全部通过；所有包 build 与 typecheck 通过；示例 benchmark 四组消融均可运行。本次更新只调整 README 的品牌定位与技术说明，不新增算法或测试成绩。

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
