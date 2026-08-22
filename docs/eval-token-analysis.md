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

1. **修正循环改增量复核**（对带修正的 run 影响最大）。每轮 correction 后目前整跑
   verification + independent-review。`recheck --scope` 已有"只重验未满足检查项"
   的机制，应把同样的增量思想用于 correction 循环：只重验受影响文件/检查项，
   独立复核只审 diff 而不是重读全仓库。预计每轮修正的重验成本从 ~475K 压到 <150K。
2. **审查节点数量与输入打包**（干净跑最大头，38.7%）。55 行的小仓库跑 5 个域审查，
   每个节点都在重复翻同一批文件。`--max-review-nodes` 应按 workspace 规模自动收缩
   （小仓库合并为 2-3 个综合审查节点，四个必需域仍要覆盖）；同时把 discovery 的
   发现清单和相关文件内容直接打包进审查输入，减少 agent 自行翻找的工循环。
   预计 744K → ~450K。
3. **独立复核输入瘦身**。independent-review 的 input.md 是全量 transcript
   （123KB）。复核需要独立的仓库访问权，但不需要冗长历史：输入只给变更清单 + diff，
   让它自己在冻结仓库里验证。预计每轮 300K → ~150K；四轮制下最多省 ~600K。
4. **supervision 节点的缓存前缀修复**。planner-supervision 与
   implementation-supervision 的 cached_input_tokens 为 0（其它节点 70% 命中）。
   把系统提示和共享上下文做成稳定前缀、变化内容放尾部，可白拿约 30K/节点。
5. **discovery 输出结构化**。discovery 的 20 倍输入放大说明它在反复定位文件。
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
