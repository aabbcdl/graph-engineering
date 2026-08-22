# 第二个评测 Fixture 设计方案：jobqueue（Go）

状态：已实现（2026-08-22）。Go、规模、缺陷配额与实验协议按本稿冻结。

## 目标

booking-ledger（55 行、6 个缺陷、单文件语义）只够验证 harness 本身。
第二个 fixture 要在单 agent 开始出现漏检的规模上检验 Graph 的结构优势：

- 2,000-3,000 行 Go 源码（不含测试），5-8 个模块；
- 20+ 个跨模块缺陷，每个都藏在通过的公共测试后面；
- 机器可验证的 required checks：`go build ./...` 与 `go test ./...`；
- 与 fixture #1 形成语言与缺陷类型多样性。

选择 Go 的理由：静态类型使跨模块契约缺陷（单位不匹配、接口违背）自然且可判定；
`go test` 提供无需安装依赖的确定性验证命令；并发缺陷（race、泄漏）是单 agent
审查的已知弱区。备选 Python（模型训练分布更密集，可能对两臂都偏容易）。

## 主题与模块

一个小型任务调度库 `jobqueue`，README 与 `docs/contract.md` 描述完整预期行为
（即缺陷所违背的契约）：

| 模块 | 职责 | 预计行数 |
|---|---|---|
| queue | FIFO 任务队列、优先级、批量与维护操作 | ~400 |
| worker | worker 池、优雅关闭、指标 | ~450 |
| retry | 指数退避、错误分类 | ~300 |
| store | JSON snapshot、JSONL journal、恢复 | ~500 |
| scheduler | 周期调度、时区处理、recurring calendar | ~500 |
| api | 公共 API（Enqueue/Dequeue/Ack/Stats）与操作面 | ~350 |
| events | 事件钩子、观察者、事件 recorder | ~300 |
| config | 配置解析、环境覆盖与校验 | ~250 |

公共 package tests 覆盖正常 API 行为并全部通过；缺陷均为公共测试未覆盖的行为偏离。

## 缺陷分布（20+ 个，类别先于具体内容冻结）

| 类别 | 数量 | 示例 |
|---|---|---|
| 并发 | 5 | 队列数据竞争、关闭期间 worker 泄漏、channel 双写、map 无同步访问、丢失唤醒 |
| 错误处理 | 4 | 吞错误、错误包装丢失类型、持久化部分写不回滚、fsync 错误被忽略 |
| 边界条件 | 4 | 退避上限 off-by-one、空队列挂起、max-retries 差一、调度器 DST 处理 |
| 跨模块契约 | 4 | scheduler 与 retry 的毫秒/秒单位不匹配、config 字段被 store 忽略、api 泄漏内部类型、事件钩子在 Ack 之后才触发 |
| 资源泄漏 | 3 | 错误路径文件句柄泄漏、ticker 未 Stop、context 取消后 goroutine 泄漏 |
| 语义/文档偏离 | 3 | 实际 LIFO 与文档 FIFO 相反、Stats 分母错误、恢复顺序颠倒 |

类别配额在观察任何一臂的结果之前确定；**入选标准是类别覆盖与真实感，
不包含"baseline 必须失败"**——这是基准选择偏差，协议明令禁止。

## Truth 与评分

- `evals/fixtures/jobqueue.truth.json`：每个缺陷含 `id`、文件与区域、类别、
  行为描述、验收证据（修复后应满足的可观察行为）；
- `evals/fixtures/jobqueue.evaluator.mjs`：沿用 booking-ledger 的评分契约，
  按 `defect_id` + 文件证据把 agent 发现映射到 truth；
- truth 在首次 baseline 运行前写入并冻结；pilot manifest 声明
  `truth_sha256`，pair-runner 在启动 arm 前验证，冻结后不得因任何一臂的
  表现修改 truth。

## 冻结与实验协议

1. 先实现无缺陷版本，私有测试全绿；
2. 逐个 seed 缺陷，每步公共测试必须保持通过；
3. `hashTree` 记录 fixture 与 truth 哈希进 manifest；
4. 先做 1 次探索性运行校准预算/时长（探索运行不属于预声明实验，不进报告）；
5. 校准后预声明 5 repetitions 的配对实验，走 harness binding 协议。

## 验收

- fixture + truth + evaluator + manifest 齐备且被 `npm run test:eval` 的
  real-fixture 测试覆盖（参照 booking-ledger 模式）；
- 公共测试在 seed 全部缺陷后仍 100% 通过；
- truth 缺陷数 ≥20 且类别配额符合上表。

当前实现证据：

- `evals/fixtures/jobqueue`：18 个 Go 源文件、2,235 行源码；
- `go build ./...` 与 `go test ./...`：使用 SHA-256 校验的 Go 1.27.0
  toolchain 通过；
- `evals/tests/real-fixture.test.mjs`：验证 23 个隐藏验收、六类配额、无
  fixture 残留和自然语言 finding 映射；
- frozen truth canonical SHA-256：
  `5742cd408da425421868fa5d9a70e9ee827d7ff9bfe57cd807d574c0ffa76232`。
