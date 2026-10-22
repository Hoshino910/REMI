# 同类项目参考取舍

本次只使用公开资料与少量源码核查来决定设计取舍，不复制其他项目代码，不安装同类插件，不将它们的 README 声明当作已复现结果。截图是搜索页摘要，不能代表当前实现，更不能据此判断整个项目优劣。

| 项目/核查来源 | 可取的设计思想 | REMI 的取舍 | 证据边界 |
|---|---|---|---|
| [bass1125/imemory](https://github.com/bass1125/imemory/blob/main/README.md)；`imemory.mjs` 的 rerank、工具和事件注册 | 有明确的 search/add/update/forget 管理入口；区分用户手工内容与自动提炼 | 实现共享 MemoryManager 和明确 ID 修订/删除；保留 SQLite 与现有评分，不采用双 Markdown 文件作唯一真相源 | README 当前首行提示不适配最新版 DSH；源码仍使用 `agent/pre-step` / `agent/turn-stopping` 等旧事件。没有在当前宿主加载 |
| [seriousz158/dsh-memory](https://github.com/seriousz158/dsh-memory/blob/main/README.md) | 操作预览、明确状态、审计与恢复边界 | 借鉴操作语义；REMI 的 recall/consolidation-preview 不写访问统计、不强化图；删除不宣称 secure erase | 当前 README 是 Git-backed，不是截图所称轻量 SQLite；未跑该项目测试 |
| [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon/blob/main/README.md) | 来源与策略分离、每轮使用证据可见、分层与明确作用域 | 保留 core/store/adapter/benchmark 分层，新增 manager；用 trace 解释选中/拒绝原因；避免为了大面板引入另一套存储 | 资料检查，不代表功能/性能已独立验证 |
| [yihefeikong-rgb/dsh-cc-haha-memory](https://github.com/yihefeikong-rgb/dsh-cc-haha-memory/blob/main/README.md) | 明确记忆 ID、项目隔离、更新不按模糊标题覆盖 | 采用明确 ID 与 host 配置的 owner/project 绑定；不采用“同一 session 注入过就永久不再注入”，因为 REMI 是可替换的动态透明窗口 | README/元数据核查，没有复现该项目 |
| [csyangwen/dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve/blob/main/README.md) | 项目级记忆与长期/短期信息区分 | 用显式项目作用域；暂不引入任务调度、技能自改或多 Agent 编排，优先保护 REMI 的检索质量、Hebbian 与 affect 主线 | 声明的“五轨”和其他能力未独立验证 |
| [slow-stack/mneme](https://github.com/slow-stack/mneme/blob/main/README.md)，原 `modusensus/dsh-mneme` | 可审计整理、冲突待裁决、尊重人工改动、后台失败显式化 | consolidation 先做不自动应用的提议；未来模型 resolver 必须有来源、状态和事务凭证；当前不强加后台 LLM 整理 | 已确认旧路径迁移；未复现其自动整理或性能声明 |
| `dsh-engram` | 截图没有 owner，不能唯一定位；[skepsun/dsh-engram](https://github.com/skepsun/dsh-engram/blob/master/README.md) 与 [kenz1117/dsh-engram](https://github.com/kenz1117/dsh-engram/blob/main/README.md) 是不同项目 | 只保留“预算明确、来源与旧事实可解释”这些通用原则；不把它们的不同机制混写成一个竞品，也不照搬“记忆宫殿”隐喻 | 分别读取两个 README；截图所指项目仍不确定 |

REMI 的主线保持为：可追溯的持久记录 → 事实生命周期 → 选择性召回 → 有界 Hebbian 关联 → 低权重 affect → 可替换透明窗口 → 宿主原生压缩事务。Hebbian 与 affect 的正常默认值均为开启，只有专门的测试组临时消融。
