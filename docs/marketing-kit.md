# Graph Engineering：价值与宣传资料包

这份资料包把 Graph 的宣传从“多 Agent 看起来很强”改成可验证的产品叙事。它可以直接用于 GitHub 首页、演示视频、项目介绍、发布文章和后续评测。

## 一句话定位

Graph Engineering 是一个面向本地代码仓库的、可暂停可恢复、证据驱动的多 Agent 工程控制平面。

英文短句：

> A durable, evidence-driven control plane for long-running multi-agent repository work.

## 它解决什么问题

普通单 Agent 适合短任务，但大型仓库和长任务容易遇到四类问题：

1. 上下文越积越长，后半程重复浏览和重复决策；
2. 多个模型进程并发时，预算、排队和取消边界不清楚；
3. 宿主进程、模型服务或单个节点中断后，状态可能停在“看起来还在运行”；
4. 模型说“修好了”不等于命令、文件、权限和独立复核都证明它修好了。

Graph 的价值不是简单增加 Agent 数量，而是把这些问题交给一个持久化控制平面处理：

~~~mermaid
flowchart LR
    U[用户目标] --> C[Graph 控制平面]
    C --> A[预算 admission]
    C --> I[隔离 execution workspace]
    C --> R[并行 specialist review]
    C --> V[机器证据与独立复核]
    A --> O[可恢复 Run]
    I --> O
    R --> O
    V --> O
~~~

## 可以诚实宣传的能力

- 长任务有持久化 Run、checkpoint、watch、report 和 resume；
- 模型调用启动前有 Run 级 token reservation，预算耗尽不会把同一波次继续重试下去；
- review 模式默认只读，隔离模式默认不修改源仓库；
- 每个结果同时保留模型产出和主机观察到的命令、退出码、文件变化、哈希与生命周期事件；
- 已完成节点和未完成节点分开报告，后续可以只恢复未完成部分；
- 模块地图和有界上下文减少大型仓库的重复定向，同时保持 exact snapshot 语义不变。

“减少重复浏览”“更容易恢复”“更容易审计”是当前实现目标和可测量假设；在没有足够配对实测之前，不要写成“必然更快”“必然更省 token”或“必然发现更多缺陷”。

## 价值证明阶梯

宣传材料应按下面的证据等级写，不能跨级推断：

| 等级 | 证明内容 | 当前可用证据 |
|---|---|---|
| L0 | CLI、安装包和状态契约能运行 | 本地语法、单元、集成、package smoke |
| L1 | 预算、取消、恢复和证据链按契约工作 | fake-agent 回归与 run.json/runtime-state.json 对照 |
| L2 | 在真实仓库上能完成指定任务 | 绑定仓库、目标、模型、预算的真实 Run 报告 |
| L3 | 相比单 Agent 有稳定收益 | 至少五组同 fixture、goal、model、effort、budget 的 paired evaluation |
| L4 | 用户长期愿意采用 | 安装成功率、首次有效 Run、复用率、失败恢复率和支持反馈 |

当前可以宣传 L0/L1 的工程证据；L2 需要逐个展示真实 Run；L3/L4 必须等外部实测，不能用测试数量代替。

## 三分钟演示脚本

### 0:00—0:30：安装与检查

~~~bash
git clone https://github.com/aabbcdl/graph-engineering.git
cd graph-engineering
npm run install:global
graph-engineering validate
graph-engineering doctor --agent-backend codex --json
~~~

画面重点：没有手工复制 Skill，没有启动常驻服务器；安装结果和环境缺口可读。

### 0:30—1:00：只读预览

~~~bash
graph-engineering preview \
  --workspace "/path/to/repository" \
  --goal "Review the repository for architecture and reliability risks" \
  --json
~~~

画面重点：预览不会创建 Run、不会联系模型、不会修改目标仓库。

### 1:00—2:15：受控 review Run

~~~bash
graph-engineering start \
  --workspace "/path/to/repository" \
  --goal "Review the repository and report only evidence-backed findings" \
  --mode review \
  --machine-preflight \
  --user-approved
~~~

画面重点：模块地图、并发 review、预算事件、只读隔离、watch 进度和最终 report.md。

### 2:15—3:00：展示证据而不是展示口号

依次打开：

- report.md：人类可读结论、缺口和下一步；
- completion.json：机器可读的终态、检查和 blocker；
- workspace-module-map.json：大型仓库的确定性模块地图；
- events/events.jsonl：admission、attempt、取消、恢复和结果交付；
- results/：隔离结果和冲突检查后的 apply 入口。

演示禁止使用真实用户私有源码、凭据、模型 token 或未授权的生产仓库。

## 应该测什么

### 可靠性

- completed_run_rate
- resume_success_rate
- stale_active_run_count
- budget_stop_without_retry_rate
- unfinished_sibling_cancel_rate

### 质量

- validated defect precision / recall
- independent confirmation rate
- verification pass rate
- regression rate
- false-positive rate

### 成本与速度

- observed tokens per completed goal
- wall time、queue time、model time
- repeated context reads
- number of model-process attempts

### 信任与安全

- review-only source mutation count（目标为 0）
- apply conflict rejection rate
- evidence completeness
- unauthorized action count（目标为 0）

每个指标都要绑定一个 Run、一个 fixture 或一个明确的生产数据来源。不要从单次运行的 token 数推导长期成本优势。

## 宣传文案模板

### GitHub 副标题

> Durable, evidence-driven multi-agent engineering for local repositories—with bounded budgets, isolated workspaces, resumable runs, and independent review.

### 30 秒介绍

> Graph Engineering turns a repository goal into a durable engineering run. It coordinates planning, specialist review, implementation, verification, and independent review while persisting checkpoints, budget decisions, machine evidence, and the exact final state. It is built for long-running work where “the Agent replied” is not the same as “the repository is proved correct.”

### 社交媒体短文

> Coding Agents are good at proposing changes. Graph Engineering adds the control plane for the work around those changes: isolated execution, budget admission, resumable runs, machine-observed evidence, and independent review. Mac-first, local, explicit opt-in, and honest about what has—and has not—been proven.

### 不要使用的说法

- “一定比单 Agent 更强”；
- “一定节省 token”；
- “完全自动修复任何仓库”；
- “已支持所有平台”；
- “模型说通过，所以已经通过”。

## 宣传资料最小套件

发布第一个公开版本时，准备以下五项就够了：

1. README：一句话定位、Agent 安装指令、三分钟 quick start、边界和证据链接；
2. 一段 90 秒终端录屏：安装 → preview → review Run → report；
3. 一张架构图：用户目标 → Graph 控制平面 → 隔离工作区 / Agent / 证据；
4. 一份脱敏的完整 Run 报告：包含成功、等待、取消或恢复中的真实状态；
5. 一份 paired evaluation 报告：至少五组绑定条件的 Graph 与单 Agent 对照，并同时报告质量、成本、耗时和失败率。

README 和录屏负责让人理解，Run 报告负责让人相信，paired evaluation 负责让人判断是否值得采用。

## 发布前检查

- GitHub 仓库 URL 已确定，README 和公开文档中不再保留仓库地址占位符；
- Mac 安装、Codex/Claude backend doctor 和真实小仓库 Run 有机器证据；
- NPM `graph-engineering@0.3.1` 发布候选已通过包内容检查，具备明确版本和显式 Skill 安装命令；公开发布仍以同一提交的 CI、registry、tag 和 Release 证据为准；
- 真实 Agent smoke、paired evaluation 和产品效果结论分开报告；
- 所有截图、录屏、报告和文案都移除私有路径、凭据、token 与用户源码。
