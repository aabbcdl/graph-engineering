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
- `D:\project\graph-engineering` 保持唯一源仓库，全局 Skill 仅作为发布安装物。

发布物只包含可执行的 runner、Skills、评测代码和冻结 fixture；`evals/results/`、`.workbuddy/` 以及其他本地运行产物不进入 npm 包。这样既保留了开源复现实验所需的材料，也避免把本机路径、模型调用证据和可能包含项目上下文的历史结果当成公共接口发布。

验收：评测脚本、恢复测试和文档审查全部通过后，才做性能结论；单次真实项目运行不能被描述为统计证明。

## 当前已完成

- runtime 状态、事件、artifact、证据验证模块已加入。
- runner 已写入节点生命周期事件、planner 生命周期事件、结果 artifact 和工作项交付章节。
- `completed_with_gaps`、`waiting_environment` 和部分结果已进入报告与 completion artifact。
- watcher 已显示工作项计数、队列、健康状态和阻塞建议。
- `graph-engineering events` 已提供无模型、只读的事件流读取入口。
- `preview`、`diff`、`apply`（含 `--dry-run` 与选择性 `--file`）、`recheck`、`runs`、`gc` 六个控制面操作已实现并有 CLI 契约测试覆盖（只读性、无状态残留、变更分类、冲突检查、部分应用记录、recheck 守卫与 `already-satisfied` 快路径）。
- 15 项改进计划五个阶段全部交付；`npm test`（255）、`npm run test:eval`（10）、`npm run validate`（72 项检查）全部通过。
- 本计划、设计说明、架构说明和使用说明已同步描述同一状态语义。

## 明确不在本次自动化范围内

- 不自动提交、推送、部署、发布或执行不可逆数据操作。
- 不把 partial 结果自动合并回源工作区。
- 不用模型轮询替代确定性 watcher。
- 不用新的 Graph 运行来修改 Graph 自身，避免递归和资源互相占用。

## 完成定义

本次改造只有在以下条件同时满足时才可称为“实现完成”：

- 主 runner 和 runtime 模块语法检查通过；
- `npm test`、`npm run test:eval`、`npm run validate` 全部通过；
- 文档中的状态、命令和实际 CLI 行为一致；
- 最终 diff 不包含未经说明的生成文件或源工作区写入；
- 未通过的真实项目运行仍按其实际终态报告，不被测试通过替代。
- `npm pack --dry-run` 不包含 `evals/results/` 或 `.workbuddy/`，且包含新的 runtime 模块。
