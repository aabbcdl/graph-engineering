# Graph Engineering

[English](README.md) | [简体中文](README.zh-CN.md)

> 面向长时间、多 Agent 仓库工作的本地、可暂停恢复、证据驱动控制面。

Graph Engineering 把一个明确授权的工程目标，组织成可持久化的 Graph：规划、阶段监督、仓库发现、专业审查、综合、实现、验证和独立复审。它适合需要隔离执行、有限预算、可恢复进度和可核验结论的复杂仓库任务。

它不是常驻服务器，也不是另一个模型 SDK。用户入口是安装后的 Skill；Skill 会驱动 graph-engineering runner，再由 runner 调度新的 Agent 进程。

## 最短上手路径

- 新用户：把 GitHub 地址和安装提示词交给一个能执行 shell 命令的 Agent，完成一次安装。
- 之后每个仓库任务：打开目标仓库的新 Agent Session，粘贴一段运行提示词即可。
- 全仓库只读检查使用 review 模式；全仓库审查并准备修复使用 audit 模式。
- Graph 默认在隔离的 Git worktree 或安全副本中运行，写入不会自动回到原仓库。
- 每次新 Run 前，Skill 要求先检查 Graph 自身版本和完整性；无法确认版本时不会把它当作最新版本。
- apply、提交、推送、发布和部署都是独立授权，不会因为创建 Graph Run 而自动发生。

## 新用户安装

### 推荐方式：交给 Agent

把本仓库的 GitHub URL 发给一个可以执行本地 shell 命令的 Codex 或 Claude Agent，然后粘贴下面的提示词：

~~~text
请在这台 Mac 上安装 Graph Engineering，来源就是上面的 GitHub 仓库。

1. 先阅读仓库中的 README.md、README.zh-CN.md、AGENTS.md（如果存在）、CONTRIBUTING.md 和 SECURITY.md。
2. 检查 Node.js 是否为 20 或更高版本，并检查 Codex CLI 或 Claude Code CLI 是否已安装且可用。
3. 如果本地没有这个仓库，先 clone；如果已有，先确认绝对路径和 Git remote，不要猜测或覆盖其他目录。
4. 在 Graph Engineering 仓库根目录执行 npm run install:global。
5. 执行 graph-engineering validate，再执行对应的 graph-engineering doctor --agent-backend codex --json 或 --agent-backend claude --json。
6. 执行 graph-engineering version --check --json，报告安装来源、版本、commit、完整性和公开渠道状态。
7. 不要发布到 NPM，不要推送 GitHub，不要修改其他项目，也不要在我另行授权前启动真实 Graph Run。
8. 报告实际执行的路径、命令、通过的检查，以及仍存在的环境或预算阻塞。
~~~

安装完成后，建议打开一个新的 Agent task，让它重新发现刚安装的 Skill。安装本身不会授权 Graph 去操作任何目标仓库，也不会授权应用生成的修改。

### 等价的手动安装

Graph 当前以 macOS、尤其是 Apple Silicon 为主要验证目标，需要 Node.js 20+ 和已经配置好的 Codex 或 Claude CLI。

~~~bash
git clone https://github.com/aabbcdl/graph-engineering.git
cd graph-engineering
npm run install:global
graph-engineering validate
graph-engineering doctor --agent-backend codex --json
graph-engineering version --check --json
~~~

安装器会把八个 Graph Skill 复制到 ~/.codex/skills，并在全局 npm bin 目录写入 graph-engineering launcher。它使用显式、事务化的安装步骤，不通过 npm postinstall 静默修改用户目录；检测到活动中的 Graph runner 或模型 lease 时会拒绝替换。

也可以使用 NPM 包（当目标版本已经发布到 registry 后）：

~~~bash
npm install -g graph-engineering
graph-engineering-install
graph-engineering validate
graph-engineering doctor --agent-backend codex --json
graph-engineering version --check --json
~~~

源码 GitHub 主线和 NPM latest 是两个不同渠道。不要因为本地 package.json 版本号较新，就推断 NPM 已经有相同版本。

## 它是怎么被驱动的

正常使用时，你不需要手动编排每个 Graph 节点。调用链是：

~~~text
你的提示词
  -> 当前 Agent Session
  -> 已安装的 autonomous-engineering-graph Skill
  -> graph-engineering version / preview / submit
  -> Graph runner
  -> Planner、specialist、synthesis、implementation、verification、independent review
  -> report.md、completion.json 和隔离结果
~~~

Skill 只有在当前任务明确提到 Graph Engineering、graph-engineering，或接受 Agent 给出的明确 Graph 建议时才会启动。单纯说“帮我看看代码”、文件很多、或者上一个 task 用过 Graph，都不会隐式创建新 Run。

每次创建新 Run 前，Skill 会要求：

1. 执行 graph-engineering version --check --json。
2. 只有 current 或明确可识别的 ahead_of_stable 才继续。
3. 运行只读 preview，确认仓库、隔离模式、后端、预算和环境。
4. 通过 submit --user-approved --follow 创建一个 Run 并跟踪到终态。

--follow 只是读取持久化进度，不消耗模型额度。Agent Session 关闭后，后台 runner 仍可继续；之后可以用同一个 Run ID 查看或恢复。

## 一段提示词完成全仓库审查

下面两条已经把目标和范围写死，不需要用户再填写占位符。这里的“全仓库”表示递归检查当前仓库的源代码、配置、测试、构建和发布相关文件；提示词不会把依赖目录、缓存、密钥和生成物当作主要源码范围，但这些内容对快照、构建或发布的影响仍会被记录。

### 版本一：全仓库只读审查

~~~text
请使用 Graph Engineering（graph-engineering）对当前 Agent Session 已打开的整个仓库执行一次全面、只读、面向可验收和可发布的质量审查。

先确认当前仓库的绝对路径，不要猜测或切换到其他仓库。范围是仓库根目录下所有受版本控制的源代码、配置、测试、构建脚本、依赖声明、文档和发布文件。

审查必须覆盖：架构与代码质量、依赖和构建、错误处理与并发、数据和状态、安全与隐私、测试可信度、产品关键流程、可访问性与本地化、平台兼容性、部署和发布门禁。

排除 .git、node_modules、vendor、缓存、生成物和密钥内容；如果这些内容会影响构建、运行或发布，请记录其影响和未验证项。不得修改文件，不得 apply、commit、push、publish、deploy，也不得执行其他外部变更。

开始前运行 graph-engineering version --check --json。只有状态为 current 或明确的 ahead_of_stable 时才继续；如果是 update_available、modified 或 unknown，停止并报告安装身份和更新路径，不要启动旧的或无法确认身份的 Graph。

我明确授权创建这一次 Graph Run。先执行只读 preview，然后使用 `--mode review` 只提交一个 review Run，并持续跟踪到终态。读取最终报告、独立复审和机器证据，区分真实缺陷、潜在风险、推测、明确失败和未验证项。不要把“未发现问题”写成“没有问题”。
~~~

review 模式会执行发现、专业审查、综合、综合监督和新的只读独立复审；它不会实现、修复、运行设备检查或生成可应用结果。

### 版本二：全仓库审查并准备修复

~~~text
请使用 Graph Engineering（graph-engineering）对当前 Agent Session 已打开的整个仓库执行一次全面审查、最小修复和验证流程。

先确认当前仓库的绝对路径，不要猜测或切换到其他仓库。范围是仓库根目录下所有受版本控制的源代码、配置、测试、构建脚本、依赖声明、文档和发布文件。

目标是达到可验收、可维护和可发布：识别有现实触发路径且影响实际结果的问题，并只实施有证据支持的最小充分修复。覆盖架构、构建、测试、错误处理、并发、数据完整性、安全隐私、用户体验、兼容性和发布门禁。

排除 .git、node_modules、vendor、缓存、生成物和密钥内容；不要为了理论上的最佳实践进行大规模重构。只能在 Graph 创建的隔离工作区修改，不得写回原仓库，不得 apply、commit、push、publish 或 deploy。

开始前运行 graph-engineering version --check --json。只有状态为 current 或明确的 ahead_of_stable 时才继续；如果是 update_available、modified 或 unknown，停止并报告安装身份和更新路径，不要启动旧的或无法确认身份的 Graph。

我明确授权创建这一次 Graph Run。先执行 preview，然后使用 `--mode audit` 只提交一个 audit Run，并持续跟踪到终态。让 Graph 完成专业审查、综合、必要的最小修复、验证和独立复审。完成后读取最终报告、完整隔离 diff、测试证据和所有未验证项。结果准备好后停止，等待我单独决定是否 apply 到原仓库。
~~~

audit 模式包含实现和验证阶段，但默认仍在隔离快照中运行。它可以产出修复结果，不代表已经修改了你的源仓库。

## 查看版本和更新

离线查看本机安装身份：

~~~bash
graph-engineering version
~~~

联网核对公开渠道：

~~~bash
graph-engineering version --check --json
~~~

输出会包含安装版本、来源、commit（如果有）、安装时间、runner SHA-256、八个 Skill 的内容指纹和公开渠道状态：

- current：当前安装身份和对应公开渠道一致。
- update_available：对应渠道存在更新。
- ahead_of_stable：本地版本高于 NPM stable，通常表示源码候选版本尚未发布。
- modified：安装后的 runner、Skill 或记录来源发生了变化。
- unknown：网络、元数据、来源或安装身份无法确认。

网络失败或缺少旧版本元数据时必须是 unknown，不能当成最新版本。version --check 只读取固定的 GitHub/NPM 元数据，不执行远端返回内容，也不发送 Provider credential。

Graph 不会在仓库 Run 中静默覆盖自身。需要更新时，把下面的提示词交给 shell-capable Agent：

~~~text
请把 Graph Engineering 更新到其记录安装渠道中可确认的最新版本。

1. 先运行 graph-engineering version --check --json，报告更新前的版本、来源、commit、完整性和公开状态。
2. 确认没有活动中的 Graph Run 或 model lease；不要为了更新而停止正在运行的任务。
3. 如果是 Git 源安装，只有在 recorded origin 确认是 https://github.com/aabbcdl/graph-engineering.git 时，才允许对干净 checkout 执行 fast-forward-only 的 origin/main 更新，然后运行 npm run install:global。不得丢弃本地修改。
4. 如果是 NPM 安装，运行 npm install -g graph-engineering@latest，然后显式运行 graph-engineering-install。
5. 如果是 legacy-missing、fork、未知 remote 或无法确认身份，使用新的官方 GitHub checkout，不要直接 pull 未验证的 origin。
6. 更新后重新运行 validate、对应的 doctor 和 version --check --json。
7. 报告更新前后身份、失败检查和是否需要打开新的 Agent task 来重新发现 Skill。不要启动仓库 Run，不要 apply、commit、push、publish 或 deploy。
~~~

更新只替换 Graph 的安装物，不会自动更新目标仓库。安装器会在活动 Run 时拒绝更新，并在 staged swap 失败时恢复旧的 Skill 和 launcher。

## 手动命令

### 创建 Run

后台执行是常规方式：

~~~bash
graph-engineering submit \
  --workspace "/path/to/repository" \
  --goal "Audit and repair the repository" \
  --mode audit \
  --user-approved \
  --follow
~~~

只读审查可以显式使用：

~~~bash
graph-engineering start \
  --workspace "/path/to/repository" \
  --goal "Review the complete repository" \
  --mode review \
  --user-approved
~~~

如果不写 --workspace，runner 使用当前工作目录。建议始终让 Agent 先报告它解析出的绝对路径。

### 预览、查看和停止

~~~bash
graph-engineering preview --workspace "/path/to/repository" --goal "Review the complete repository" --json
graph-engineering status --workspace "/path/to/repository" --run "<run-id>"
graph-engineering watch --workspace "/path/to/repository" --run "<run-id>"
graph-engineering events --workspace "/path/to/repository" --run "<run-id>" --since 0
graph-engineering stop --workspace "/path/to/repository" --run "<run-id>"
~~~

preview 不创建 Run、快照或状态残留。watch 和 events 只读持久化状态，不启动模型。

### 检查差异和应用结果

~~~bash
graph-engineering diff --workspace "/path/to/repository" --run "<run-id>" --json
graph-engineering apply --workspace "/path/to/repository" --run "<run-id>" --dry-run --json
graph-engineering apply --workspace "/path/to/repository" --run "<run-id>" --file "src/example.mjs"
~~~

隔离结果不会自动合并。只有在 completion.json 明确显示 application_ready=true，并且你已经检查报告、diff、测试和冲突状态后，才应执行记录的 apply_command。Graph 不会自动 commit 或 merge。

## 隔离、权限和恢复

- 默认 --workspace-mode auto：优先 Git worktree，否则使用受管理的安全副本。
- 原仓库在 Graph Run 期间保持不变；写入型 Agent 的修改范围由隔离工作区和节点 sandbox 约束。
- 任何超出请求范围的 tracked 或 unignored 写入都会使结果失去资格，并记录为 OUT_OF_SCOPE_WRITE。
- 软链接、Windows junction 和无法安全核验的链接结果不会生成 apply 命令。
- 运行、停止和恢复都保留持久化事件、artifact hash 和 checkpoint。
- 活动 Run、服务暂停、预算等待和 owner gate 都是明确状态，不会被伪装成成功。

Graph 不会自动执行 commit、push、publish、deploy、设备重启或不可逆数据操作。高风险动作需要另外的 owner authorization。

## 预算和覆盖范围

默认 Run 上限是 6,000,000 个 observed tokens、240 分钟有效执行时间和 96 次 model-process attempt。可以显式使用 extended 或 unlimited，但预算增加不会删除历史消耗。

全仓库 audit 默认最多 6 个 specialist review 节点，并保留审计所需的最低覆盖域。小仓库会在不低于审计底线的情况下自动缩减 fan-out；如果手动降低 --max-review-nodes，结果会记录为有意降低覆盖范围。

“全面审查”是覆盖主要风险维度和完整仓库入口的工作模式，不是数学意义上的“保证找出所有问题”。模型结论仍必须由代码、测试、命令输出或运行时证据支持；缺少设备、服务、账号或真实生产环境时，结果会标记为未验证或 waiting_environment。

## Monorepo 和环境预检

当目标目录嵌套在 Git 仓库中，Graph 会快照完整仓库，但让 Agent 从请求的子目录执行；根目录 manifest 和 lockfile 也会进入预检。预检支持 Node、Python、Go、Rust、Java 和 .NET，并区分“扫描成功”和“环境可执行”。

缺少或冲突的 lockfile 不会被猜测修复；需要的依赖准备会先在隔离环境中完成，生命周期脚本默认关闭。Android/Gradle 的机器预检是显式 opt-in，不会因为普通审查自动执行设备或发布命令。

## 结果文件和状态

每个 Run 的报告目录通常包括：

- report.md：面向人的证据报告；
- completion.json：状态、检查、变更文件、阻塞原因、复审结果和 observed cost；
- finding-lineage.json：发现、独立确认、修复、验证和最终复审的 lineage；
- results/：通过冲突检查的隔离结果和 apply helper；
- runtime-state.json、events/events.jsonl 和 content-addressed artifacts/。

工作项会分别记录为 succeeded、failed、blocked、deferred 或 pending。有用工作已完成但另一个 gate 未完成时，Run 会是 completed_with_gaps，不会生成 apply 命令；waiting_service、waiting_environment 和 waiting_owner 也不会被转换成部分成功。

## 自定义 Provider

如果 Codex 配置使用自定义 Provider，Provider 的环境变量必须显式投影给 Graph 子进程。例如：

~~~bash
export AEG_CHILD_ENV_KEYS=CUSTOM_PROVIDER_API_KEY
graph-engineering doctor --agent-backend codex --json
~~~

只允许投影明确列出的环境变量；不要把密钥写入 prompt、日志、报告、Git 或 NPM 包。没有这个显式投影时，doctor 会返回 provider-auth-configured 阻塞，这是安全设计，不是 Graph 已经准备好的证明。

## 平台状态

macOS 是当前主要支持平台，Apple Silicon 是主要验证目标。Windows 仍是部分适配状态；即使包能安装，真实 Agent sandbox、路径或写入 smoke 仍可能返回 waiting_environment。Mac 上的成功不能直接证明 Windows 已准备好。

## 开发和发布

源码仓库包含评测和测试工具；NPM 包只包含可安装的控制面和必要文档，不包含本地评测结果、隐藏测试或运行产物。

~~~bash
npm test
npm run test:archive
npm run test:package-policy
npm run test:eval
npm run validate
npm run validate:package
npm run test:package-smoke
npm run release:check
~~~

发布前必须把精确 commit、CI、NPM tarball、dist-tag 和 clean-install smoke 分开核验。源码候选版本、已提交 GitHub 和已经公开的 NPM 版本不是同一件事。

更多运行细节见 [docs/usage.md](docs/usage.md)，架构说明见 [docs/architecture.md](docs/architecture.md)，发布门禁见 [docs/release-runbook.md](docs/release-runbook.md)。

## 许可证

Apache-2.0。
