# Graph Engineering 持久化控制面实施计划

本文是
[`docs/superpowers/specs/2026-08-17-durable-control-plane-design.md`](superpowers/specs/2026-08-17-durable-control-plane-design.md)
的执行清单。它记录本次大改造解决什么问题、为什么采用这个边界、每一阶段怎样验收，以及哪些工作仍然属于后续演进。

## 为什么要改

旧 runner 更像一条“模型输出文档流”：规划、审查、修复和验证主要通过节点结果连接。这个形态在短任务上可用，但在真实长任务中有三个结构性缺陷：

1. 一个子进程或模型服务失败，已经完成的节点也容易被全局 `failed` 掩盖。
2. 用户只能看到最终报告，无法知道某个工作项是否排队、重试、完成或等待环境。
3. 模型自报的命令和状态可能与主机实际观察到的退出码不一致，导致假阳性验证。

因此本次不继续堆提示词，而是引入“确定性控制面 + 可替换 Agent Worker + 独立验证器”：

- 控制面拥有 run/work-item 状态、权限、恢复点、事件顺序和 artifact 哈希；
- worker 只负责在授权边界内探索、提出发现或实施变更；
- 验证器只接受主机观察到的命令、退出码、文件哈希和测试结果；
- Graph 继续表达依赖，Loop 继续执行有上限的纠偏，但二者不能自行发明生命周期事实。

这样选择的直接收益是：服务中断可以从检查点恢复；晚到的失败不会抹掉已交付结果；报告可以诚实区分“完成”“部分完成”“等待外部条件”和“失败”。

## 当前权威状态（2026-08-30）

- 本项目以 macOS Apple Silicon 为主验证目标；公开确定性 CI 覆盖 `ubuntu-latest` 与 `macos-14`，其中 `macos-14` 与本机验证属于 Mac 发布门禁。
- `graph-engineering@0.3.0` 已是公开 NPM 版本。本轮 `0.3.1` 收口包含跨平台测试入口、CI 环境隔离和发布文档同步，只有在本地门禁通过后才发布。
- Windows protected real-agent smoke 仍是独立可选外部门，不是 Mac 用户的使用前置条件；Windows 不在本轮 Mac 发布 CI 矩阵内，没有真实 Windows 机器证据时继续标记为 `UNKNOWN`/`waiting_environment`。
- Graph 相对单 Agent 的效果仍不作结论；必须由同一 fixture、goal、model、effort、budget 的至少五组 paired evaluation 证明。
- 用户此前运行真实仓库的口头结果不替代可复核 Run artifact；标准项目状态目录中未找到可统一归档的当前报告，因此本计划不把它写成发布证据。

本节覆盖旧阶段记录中的“未发布”“未同步”“CI 未观察”等历史状态；旧日期下的结果保留作为审计轨迹，不再作为当前结论。

### 本轮收口验证（本机；2026-08-30）

- `npm test`：exit 0，302 个测试，296 pass、6 skipped、0 fail；Shell glob 不再参与测试文件发现。
- `npm run test:eval`：exit 0，45/45；`npm run validate`：72/72；`npm run validate:package`：67 个文件、17 个发布 `.mjs`、0 个 denied path。
- `npm run test:package-smoke`：exit 0；通过 NPM bin 验证 install、help、audit preview、doctor 和 package validate；`npm run release:check`：`ready`。
- 本轮变更未修改用户仓库、未运行真实模型、未提交 Graph 自身运行结果，也没有把 Windows real-agent smoke 或 Graph-vs-baseline 效果写成已证明结论。

## 阶段计划与状态

### Phase 0：基线和契约

- 固定现有 runner、评测和 specialist 校验结果。
- 定义统一的 run、work item、event、artifact 和 evidence 契约。
- 将 StorePulse/SlotFlow 真实运行中暴露的假阴性、超大输入和服务失败记录为回归场景。

验收：新 schema 可独立解析；旧 run 仍可读取和恢复；既有测试不因新字段失败。

### Phase 1：runtime 模块化

- 在 `scripts/runtime/` 中分离状态模型、事件日志、内容寻址 artifact 和确定性证据验证。
- 让 runner 只负责兼容编排，新增状态和事件通过模块写入。
- 每个模块先用纯测试验证，再接入主流程。

验收：模块测试通过；事件并发追加的序号连续；artifact 读取会校验 SHA-256；失败主机命令不能被模型 claim 覆盖。

### Phase 2：工作项级恢复与部分交付

- 将每个 Graph node 映射为一个 work item，并保存状态、attempt、阻塞原因和结果引用。
- 增加 `completed_with_gaps`、`waiting_environment`、`failed_recoverable` 等状态。
- 报告逐项列出已交付内容和缺口；部分结果不生成 apply 命令。

验收：模拟一个节点失败时，其他成功节点仍出现在 `runtime-state.json`、`completion.json` 和报告中；服务等待和 owner 等待不会被误标为部分成功。

### Phase 3：确定性验证

- required check 使用稳定 `check_id` 和等价命令声明。
- PowerShell、CMD、`pnpm exec` 等包装命令统一解包匹配。
- 只使用主机事件中的成功退出码；模型声明只作为解释性证据。

验收：代表性的 Windows 包装命令通过；退出码非零时 required check 必须失败；验证结果可由 JSON 重新计算。

### Phase 4：可观察性、通知和成本

- 所有 run 写入 `events/events.jsonl` 和 `runtime-state.json`。
- watcher 和 `events` CLI 只读这些记录及队列，不占用模型容量。
- 记录每个 attempt 的排队时间、进程时间、输入大小和可用 token 用量。
- 503/429 等临时服务错误达到阈值后进入 `waiting_service`，释放模型槽并保留恢复点。

验收：断开宿主 session 后仍可用同一 run id 查看进度；终态通知去重；事件流能够解释每次重试和阻塞。

### Phase 5：评测和开源整理

- 用相同冻结 fixture 做 Graph 与单 agent baseline 的配对实验。
- 至少收集五组完整可比样本，再报告发现率、真实缺陷率、修复率、误报率、耗时和 token 成本。
- 补齐 API、贡献指南、升级/回滚说明和安全边界。
- `<source-checkout>/graph-engineering` 保持唯一源仓库，全局 Skill 仅作为发布安装物。

源代码仓库保留可复现实验所需的评测代码和冻结 fixture；可安装 npm artifact 只包含可执行的 runner、Skills、运行时引用和必要文档，`evals/`、隐藏 truth/tests、`evals/results/`、`.workbuddy/` 以及其他本地运行产物不进入 npm 包。这样既保留了源码级实验能力，也避免把本机路径、模型调用证据和可能包含项目上下文的历史结果当成公共接口发布。

验收：评测脚本、恢复测试和文档审查全部通过后，才做性能结论；单次真实项目运行不能被描述为统计证明。

## 当前已完成（本地控制面；历史收口记录）

- runtime 状态、事件、artifact、证据验证模块已加入。
- runner 已写入节点生命周期事件、planner 生命周期事件、结果 artifact 和工作项交付章节。
- `completed_with_gaps`、`waiting_environment` 和部分结果已进入报告与 completion artifact。
- watcher 已显示工作项计数、队列、健康状态和阻塞建议。
- `graph-engineering events` 已提供无模型、只读的事件流读取入口。
- `preview`、`diff`、`apply`（含 `--dry-run` 与选择性 `--file`）、`recheck`、`runs`、`gc` 六个控制面操作已实现并有 CLI 契约测试覆盖（只读性、无状态残留、变更分类、冲突检查、部分应用记录、recheck 守卫与 `already-satisfied` 快路径）。
- 15 项控制面改进及后续产品契约修复已落地；发布准备由 `npm run test:eval`、`npm run validate`、`npm run validate:package`、`npm run test:package-smoke` 和 `npm run release:check` 共同门禁，当前版本的精确结果记录在最新收口章节。
- npm 包边界已通过 tarball 检查：本轮 `0.3.1` 为 67 个文件、18 个 references、8 个 agents，且不包含 `evals/`、隐藏测试或仓库专用 smoke 工具；`npm pack --dry-run` 同样确认包含新的 runtime module map 和 marketing kit。安装后的显式 Skill installer、`help`、audit `preview`、fail-closed `doctor` 和 package `validate` 已由 public-bin smoke 覆盖；即使用户 `CODEX_HOME` 为空，运行器也会发现包内七个可供规划的 specialist。
- `graph-engineering@0.3.0` 已通过 NPM 官方 registry 发布并验证为 `latest`；公开 GitHub `main` 与源代码同步已完成。后续 patch release 必须绑定明确提交、tag 和 tarball 校验。
- 之前记录的旧测试数字属于对应日期的历史证据；不能覆盖本轮跨平台修复后的新验证结果。
- 本计划、设计说明、架构说明和使用说明已同步描述同一状态语义。

## 大型仓库优化计划（复审版）实施状态

- **T-01 预算 admission：已实现。** 模型进程启动前写入 Run 级
  `reserved_tokens`；可用预算按“已观察 usage + 活跃 reservation”计算。
  `budget_exceeded` 统一为预算终止，不进入普通 worker retry；单个已启动
  调用允许有界终端超额，但不会再启动未预留调用。
- **T-02 fail-fast 与生命周期收敛：已实现。** review wave 的首个预算终止、
  用户 stop 或宿主中断会取消未完成兄弟节点；已完成节点保留，未完成节点
  标记为 `interrupted`，并在报告前回收 reservation、关闭 attempt、同步
  runtime state。旧 Run 继续使用 `reconcileInterruptedRuns`，恢复时清理
  没有对应活动进程的旧 reservation。
- **T-03 模块地图与上下文分片：已实现第一轮。** 每个 Run 生成确定性的
  `workspace-module-map.json`，planner/review 只接收有界的 focus-ranked
  orientation context；exact snapshot 默认行为保持不变，不自动排除生成目录，
  也没有新增 submodule 聚合接口。
- **T-04 Android/Gradle 预检：已实现 opt-in 两层边界。** 静态检查通过
  `--machine-preflight` 开启；`--machine-preflight-gradle` 才会在隔离 execution
  workspace 中执行 `projects` 和受限 task `--dry-run`，并记录命令、退出码、耗时
  与文件 surface 变化。工具链缺失属于 `waiting_environment`，未请求或未执行
  的 probe 不被记为命令失败。
- **T-05 Windows smoke：保留为外部门禁，当前未宣称 ready。** Mac 端只准备
  runner 和证据契约；没有真实 Windows protected smoke 时状态继续是
  `UNKNOWN`/`waiting_environment`。五组 paired evaluation 也尚未满足，因此不
  声称 Graph 比单 Agent 更省 token 或更有效。

submodule separate 聚合和自动快照瘦身仍是后续设计/实验任务，未进入本轮公共
接口或默认行为。

## 当前仍需区分的验收门

- 真实 Agent 能力：Mac 真实仓库运行可作为使用反馈，但仓库中没有统一、可复核的当前 Run artifact；因此不把它升级为通用 `task-ready` 或发布统计证据。Windows protected smoke 仍是独立可选门。
- Graph 实际效果：`npm run test:eval` 只证明 harness contract。当前没有满足 Run v3 绑定的五组 comparable real-model pairs，既有记录保持 `claim_ready=false`；因此不能声称 Graph 比 baseline 更有效或更省 token。
- 发布状态：本轮需要在 CI、tarball、NPM registry、Git tag 和 GitHub Release 全部指向同一提交后，才可标记为 `verified-current`。

## 本轮边界

- 本轮允许提交、推送和发布 `0.3.1`，但不修改用户的其他项目、不部署服务，也不执行不可逆数据操作。
- 不把 partial 结果自动合并回源工作区。
- 不用模型轮询替代确定性 watcher。
- 不用新的 Graph 运行来修改 Graph 自身，避免递归和资源互相占用。

## 完成定义

本次改造的本地实现只有在以下条件同时满足时才可称为“控制面实现完成”；若要宣称 task-ready、效果已证实或可发布，还必须满足下方外部门禁：

- 主 runner 和 runtime 模块语法检查通过；
- `npm test`、`npm run test:eval`、`npm run validate` 全部通过；
- 文档中的状态、命令和实际 CLI 行为一致；
- 最终 diff 不包含未经说明的生成文件或源工作区写入；
- 未通过的真实项目运行仍按其实际终态报告，不被测试通过替代。
- `npm pack --dry-run` 不包含 `evals/results/` 或 `.workbuddy/`，且包含新的 runtime 模块。

外部门禁：

- 真实 Agent smoke 通过并使 `doctor` 返回 `ready`；
- 至少五组完整、绑定同一 fixture/goal/model/effort/budget 的 comparable pairs，且 scorer 返回 `claim_ready=true`；
- 对明确 release commit 观察到远程 CI、artifact identity、tag、GitHub Release 和可说明的回滚路径；Windows real-agent smoke 不属于 Mac 发布前置条件。
