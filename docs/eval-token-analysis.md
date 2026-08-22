# v2 Pilot Token 用量分析（2026-08-22）

本文分析两次已完成配对实验中 Graph 臂的真实 token 消耗分布，数据来自各节点
`proof.json` 里后端上报的 usage（`evals/results/pilot-2500k-20260816-final`
与 `evals/results/pilot-20260816-budget4000k-r2` 的 graph-state）。
两个 run 都是 Run schema v2 的历史数据，只用于指导优化，不构成性能证据。

## 总量结构

| Pilot | 总 tokens | 输入 | 其中缓存命中 | 输出 | 节点数 |
|---|---|---|---|---|---|
| 2500k-final | 1,921,077 | 1,867,650 (97.2%) | 1,309,696 (70.1%) | 53,427 (2.8%) | 14 |
| 4000k-r2 | 3,975,642 | 3,897,416 (98.0%) | 3,034,624 (77.9%) | 78,226 (2.0%) | 22 |

**输出 token 只占 2-3%。成本几乎全部在输入侧的工循环（agent 反复读文件）**，
所以优化方向是"少读、缓存读、增量读"，而不是让模型少说话。

## 干净跑（2500k-final，14 节点，无修正）分阶段

| 阶段 | tokens | 占比 | 节点数 |
|---|---|---|---|
| review（5 个域审查） | 743,940 | 38.7% | 5 |
| implementation | 331,696 | 17.3% | 1 |
| discovery | 231,825 | 12.1% | 1 |
| verification | 202,676 | 10.6% | 1 |
| independent-review | 166,115 | 8.6% | 1 |
| supervision（3 个阶段） | 89,888 | 4.7% | 3 |
| synthesis | 83,546 | 4.3% | 1 |
| planner | 71,391 | 3.7% | 1 |

输入放大倍数（input.md 字节 ÷4 约等于初始 prompt token，与实际 input token 对比）：
discovery 44KB→225K（约 20 倍）、implementation 101KB→326K（约 13 倍）、
independent-review 123KB→159K（约 5 倍）。工循环重复读同一批 55 行源文件是主要放大来源。

## 修正循环跑（4000k-r2，22 节点）分阶段

| 阶段 | tokens | 占比 | 节点数 |
|---|---|---|---|
| independent-review（r0-r3 四轮） | 1,106,494 | 27.8% | 4 |
| correction（r1-r3） | 807,552 | 20.3% | 3 |
| verification（r0-r3 四轮） | 576,324 | 14.5% | 4 |
| implementation | 574,932 | 14.5% | 1 |
| review | 469,949 | 11.8% | 4 |
| discovery | 206,863 | 5.2% | 1 |
| supervision | 88,305 | 2.2% | 3 |
| planner / synthesis | 145,223 | 3.7% | 2 |

与干净跑的 2.05M 差额几乎全部来自修正循环：3 个 correction 节点（808K）
加每轮失败后整跑的 verification（442K 增量）和 independent-review（793K 增量）。
**每进入一轮修正，就多付约 475K 的全量重验 + 重审。**

另外注意：两次 run 的 planner 选择了不同的审查域集合（5 域 vs 4 域），
planner 在审查域选择上有自由度。

## 优化杠杆（按影响排序）

实施状态（2026-08-22，提交待引用）：

1. **[已实现] 修正循环改增量复核**（对带修正的 run 影响最大）。每轮 correction 后目前整跑
   verification + independent-review。`recheck --scope` 已有"只重验未满足检查项"
   的机制，应把同样的增量思想用于 correction 循环：只重验受影响文件/检查项，
   独立复核只审 diff 而不是重读全仓库。预计每轮修正的重验成本从 ~475K 压到 <150K。
   实现方式：`makeLoopNode` 为第 1 轮及以后的 verification 节点计算上一轮
   unsatisfied 检查集（`incremental_check_ids`），prompt 与 runner 端评估都按此集合
   作用域化；independent review 节点的 focus 收窄为上一轮被拒的发现与修正涉及面，
   同时保留对冻结仓库的完整独立访问；runner 在最终汇总时按 check id 跨轮合并
   `machine_check_evaluation`，早轮已记录的通过项保持有效，晚轮重跑的结果覆盖同 id。
2. **[已实现] 审查节点数量与输入打包**（干净跑最大头，38.7%）。55 行的小仓库跑 5 个域审查，
   每个节点都在重复翻同一批文件。`--max-review-nodes` 应按 workspace 规模自动收缩
   （小仓库合并为 2-3 个综合审查节点，四个必需域仍要覆盖）；同时把 discovery 的
   发现清单和相关文件内容直接打包进审查输入，减少 agent 自行翻找的工循环。
   预计 744K → ~450K。
   实现方式：`effectiveReviewLimits` 用有界只读目录遍历测量 workspace 规模
   （≤30 文件且 ≤256KB 判为小型），仅在用户未显式固定 `--max-review-nodes(-per-wave)`
   /`--max-total-review-nodes` 时收缩；audit 模式的下限是四个必需域
   （engineering/product/experience/security），task 模式下限 2；决策与测量值记录在
   `coverage.auto_review_scaling` 并随 run 持久化，resume 与旧 run 不受影响。
   输入打包已实现文件地图部分：`workspaceFileMap` 为 discovery 与 review 节点
   注入有界的仓库文件清单（跳过 .git/node_modules 等生成目录，200 条/12KiB 封顶），
   前置定位信息以减少工循环中的重复翻找；更深的 discovery 结果嵌入留待实测验证。
3. **[已实现] 独立复核输入瘦身**。实测 independent-review-r0 的 115KB 输入构成：
   skill 全文约 62KB（54%）、上游 verification 结果约 48.5KB（42%）、头部样板约 4.6KB。
   实现方式：`compactResultForDependency` 为 independent_review 节点改用
   「机器事实优先」形态——保留 findings 身份（id/fingerprint/title/disposition/
   related_finding_ids，供 lineage 保持）、checks、files_changed 与 runner 计算的
   `machine_check_evaluation` 逐项状态，丢弃自述 evidence 长文、recommended_action、
   evidence_anchors 与命令转录，并附注要求复核者自行在仓库中重推证据。这与
   「fresh-context reviewer 不得信任自报成功」的角色约束一致；其它节点类型的
   依赖压实不变。预计每轮 300K → ~150K；四轮制下最多省 ~600K。
4. **[已评估，暂缓] supervision 节点的缓存前缀修复**。planner-supervision 与
   implementation-supervision 的 cached_input_tokens 为 0。分析后确认这不是前缀
   排列问题：缓存命中主要来自同一节点内多轮工循环的会话前缀复用，而 supervision
   节点被明确禁止调用工具（单轮请求），结构上无法产生多轮前缀；跨进程的服务端
   前缀缓存能否命中无法在本仓内验证。重排 prompt 把稳定内容前置收益不可证，
   且会削弱节点身份声明的位置，故暂缓。
5. **[未实现] discovery 输出结构化**。discovery 的 20 倍输入放大说明它在反复定位文件。
   给 discovery 的 prompt 附带仓库地图（文件清单 + 入口点摘要）可显著降低翻找成本。

## 量化预期

| 场景 | 现状 | 应用杠杆 1-4 后预期 |
|---|---|---|
| 干净跑（2.5M 档） | 1.92M | ~1.4M（-27%） |
| 带修正跑（4M 档） | 3.98M | ~2.3M（-42%） |

前提：这些改动不得降低质量指标——每项都要用配对实验验证质量不劣化后才能保留，
这与评测协议的 cost-efficiency 指标（validated defects / 1M tokens）一致。

## 复现

```powershell
node evals/scripts/analyze-run-tokens.mjs evals/results/<pilot>/runs/<fixture>/<rep>/graph-state
```

（脚本随本文一起提交。）
