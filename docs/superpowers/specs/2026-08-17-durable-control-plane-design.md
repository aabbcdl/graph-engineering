# Durable Control Plane 重构设计

## 背景

Graph Engineering v2 已经具备隔离工作区、角色化 Agent、队列、证据记录、独立复核和结果应用等能力，但真实的 StorePulse 与 SlotFlow 运行暴露出一个结构性问题：有效的局部工作会被最后一个门禁的误判整体扣留。当前的 `graph-runner.mjs` 同时承担图编译、模型调度、状态保存、证据判断、重试和最终验收，导致单个运行时故障可以使整条流程不可交付。

这次改造的目标不是继续增加提示词，而是把工作流事实从模型输出中收回到确定性的控制面。Graph 仍然描述依赖关系，Loop 仍然描述纠偏路径，模型节点变成可替换的 worker，控制面负责状态、权限、事件、证据和恢复。

## 设计原则

1. **控制面优先**：模型只能产生带证据引用的 artifact，不能决定运行状态或机器检查是否通过。
2. **工作项级交付**：一个节点失败不能抹掉无关的已验证结果；运行允许以 `completed_with_gaps` 结束。
3. **确定性证据**：命令用稳定的 `check_id` 和主机观察到的 argv、退出码、工具事件判定，不用文本相似度代替事实。
4. **可恢复而非重复**：每个工作项和尝试都有 checkpoint、事件序号和幂等标识；恢复只重做未完成或明确失效的工作。
5. **隔离应用**：默认在冻结 worktree/copy 中写入，结果按补丁单元冲突检查后再应用到源目录。
6. **可观察性是产品能力**：阶段、队列、等待原因、成本、成功项和失败项都通过事件流和终态报告暴露。

## 目标边界

### 控制面

负责运行状态机、调度和 admission、重试与熔断、checkpoint/lease、权限门禁、事件、artifact 索引、报告和通知。

### Agent worker

负责探索、审查、设计和限定范围内的实现。Codex、Claude 及后续 backend 均通过同一个 worker contract 接入。

### 确定性验证器

负责执行测试、lint、typecheck、build 和文件/哈希检查，保存原始主机证据并计算 check 状态。模型的自报结果只作为说明，不作为门禁事实。

## 状态模型

运行状态：`created`、`preflight`、`queued`、`running`、`waiting_service`、`waiting_environment`、`waiting_owner`、`completed_with_gaps`、`completed`、`failed_recoverable`、`failed_system`、`cancelled`、`interrupted`。

工作项状态：`pending`、`running`、`succeeded`、`failed`、`blocked`、`deferred`、`superseded`。

`completed` 只表示所有必需工作、验证和独立复核完成；`completed_with_gaps` 表示已有可审查的验证结果，但仍有明确的环境、服务或独立复核缺口。两者都必须生成完整报告，不能把后者描述成完全完成。

## 持久化模型

运行元数据和事件采用 SQLite WAL（当前兼容层先使用追加式 JSONL 事件文件），大型 artifact 以 SHA-256 内容地址保存。核心实体为 `Run`、`WorkItem`、`Attempt`、`Artifact`、`Evidence`、`Gate`、`Lease` 和 `Notification`。事件包含 `sequence`、`event_id`、`run_id`、`work_item_id`、`attempt_id`、时间、类型和 payload，保证断线查看、重放和幂等处理。

## 失败策略

- 503/429/网关拒绝：指数退避，达到阈值后进入 `waiting_service`，释放模型容量，不继续消耗 token。
- 缺数据库、浏览器或外部服务：进入 `waiting_environment`，不伪装成代码失败。
- 命令包装差异：由 check adapter 归一化，不让模型重复改写同一条命令。
- 可修复的实现/验证失败：生成新的 correction hypothesis，并只重跑受影响工作项。
- 高风险动作：保留为精确 owner gate；低风险修复仍在隔离区自动完成，但不自动写回源目录。

## 兼容策略

第一阶段不替换已有 specialist prompt、隔离机制、队列、模型路由、finding lineage 和 apply 冲突检查。新增 runtime 模块先以兼容层接入现有 runner，并保留旧 run 的读取和恢复能力。后续再将 `graph-runner.mjs` 拆成 control-plane、scheduler、worker-runtime、evidence、isolation、reporting 和 CLI 模块。

## 验收标准

- runner 现有测试和评测协议保持通过；
- 节点被杀或服务连续 503 后，恢复只执行未完成节点；
- 一个验证失败不再丢失其他已完成 work item；
- 机器通过的 check 不会因为模型改写命令而被判为缺证据；
- 每个终态都有 `completion.json`、事件流和明确的成功/失败/等待清单；
- StorePulse 与 SlotFlow 的两类真实失败各有回归测试；
- 至少五组完整配对实验后，才允许发表 Graph 优于 baseline 的数据结论。
