# NPM Release Runbook

<!-- release-controls
release_owner=aabbcdl
monitoring_owner=aabbcdl
rollback_baseline=graph-engineering@0.3.1
failure_threshold=any_identity_mismatch_or_smoke_failure
-->

本手册适用于 `graph-engineering@0.3.2` 的 NPM 正式发布。Release owner 和发布后 monitoring owner 均为 `aabbcdl`。当前可回滚基线是 `graph-engineering@0.3.1`。

本手册只定义门禁、观察和恢复流程，不授权执行 `npm publish`、创建 Git tag 或创建 GitHub Release；这些外部动作必须另行获得明确授权。

## 发布顺序

1. 候选提交已推送到 `origin/main`，本地 `HEAD`、`origin/main` 和 CI `headSha` 完全一致。
2. 精确候选提交的 Node 20 `ubuntu-latest` 与 `macos-14` CI jobs 全部为 `success`。
3. 本地完整门禁、候选 tarball 身份和 staged secret/generated-file 扫描通过。
4. `npm whoami --registry=https://registry.npmjs.org/` 返回 `aabbcdl`。
5. 获得单独发布授权后执行 NPM publish。
6. 完成 registry 身份核验和 clean-install smoke 后，才创建 `v0.3.2` tag 和 GitHub Release。

## 候选身份

在候选 checkout 中记录以下结果。任何 SHA 不一致都停止发布：

```bash
git fetch origin
candidate_sha="$(git rev-parse HEAD)"
test "$(git rev-parse origin/main)" = "$candidate_sha"
gh run list --workflow CI --commit "$candidate_sha" --json databaseId,headSha,status,conclusion,url
```

使用 `gh run view <run-id> --json headSha,status,conclusion,jobs` 确认 run 的 `headSha` 等于 `candidate_sha`，且四个 Ubuntu/macOS jobs 全部成功。不得复用旧提交的绿色 CI。

生成候选 tarball，并从 `npm pack --json` 记录 `filename`、`shasum`、`integrity`、`files.length` 和 `unpackedSize`：

```bash
release_dir="$(mktemp -d)"
npm pack --json --pack-destination "$release_dir" > "$release_dir/pack.json"
node -e 'const r=require(process.argv[1])[0]; console.log(JSON.stringify({filename:r.filename,shasum:r.shasum,integrity:r.integrity,fileCount:r.files.length,unpackedSize:r.unpackedSize},null,2))' "$release_dir/pack.json"
```

## 发布前门禁

以下命令必须在同一候选提交上全部成功：

```bash
npm test
npm run test:archive
npm run test:package-policy
npm run test:eval
npm run validate
npm run validate:package
npm run test:package-smoke
npm run release:check
git diff --check
npm whoami --registry=https://registry.npmjs.org/
```

NPM publish 命令由单独授权触发。发布前不得把验证码、token 或 `.npmrc` 内容写入日志、聊天、提交或 release notes。

## 发布后身份核验

registry 可见后立即执行：

```bash
npm view graph-engineering@0.3.2 version gitHead dist.shasum dist.integrity dist.fileCount dist.unpackedSize --json
npm view graph-engineering dist-tags.latest
```

必须同时满足：

- `version` 为 `0.3.2`；
- `gitHead` 等于候选 commit；
- `dist.shasum`、`dist.integrity`、`dist.fileCount` 和 `dist.unpackedSize` 与候选 `npm pack --json` 记录一致；
- `dist-tags.latest` 为 `0.3.2`。

## Clean-install Smoke

从官方 registry 安装精确版本，禁止依赖本地 checkout：

```bash
verify_dir="$(mktemp -d)"
npm install --prefix "$verify_dir" --ignore-scripts --no-audit --no-fund --prefer-online graph-engineering@0.3.2
cli="$verify_dir/node_modules/.bin/graph-engineering"
workspace="$verify_dir/node_modules/graph-engineering"
"$cli" help
"$cli" preview --workspace "$workspace" --goal "Post-release smoke" --state-root "$verify_dir/preview-state" --json
"$cli" doctor --workspace "$workspace" --agent-backend codex --json
"$cli" validate --workspace "$workspace" --agent-backend codex --state-root "$verify_dir/validate-state" --json
```

验收条件：`help` exit 0；`preview.status=preview` 且 `creates_state=false`；批准的 Mac/Codex 主机上 `doctor.status=ready`；`validate` 不含 `FAIL`，并发现至少 7 个 bundled specialists。

## 监控窗口和失败阈值

`aabbcdl` 在 registry 首次可见时和 15 分钟后各执行一次身份核验与 clean-install smoke。该 CLI 没有常驻服务或流量看板，因此发布门禁不伪造请求量、错误率或崩溃率；发布期信号就是 registry 身份和真实全新安装的关键命令结果。

失败阈值为零容忍：任一 commit/tag/version、`gitHead`、`dist.shasum`、`dist.integrity`、`dist.fileCount`、`dist.unpackedSize` 或 `dist-tags.latest` 不匹配，或任一 clean-install、`help`、`preview`、`doctor`、`validate` 验收失败，立即触发回滚。registry 在 publish 成功后 10 分钟仍无法返回完整身份，也按失败处理。

## 回滚

先恢复 `latest`，再把失败版本标记为不可采用：

```bash
npm dist-tag add graph-engineering@0.3.1 latest
npm deprecate graph-engineering@0.3.2 "Release verification failed; use graph-engineering@0.3.1."
npm view graph-engineering dist-tags.latest
npm view graph-engineering@0.3.2 deprecated
```

确认 `latest=0.3.1` 后，从 registry 全新安装 `graph-engineering@0.3.1` 并重跑 `help`、`preview`、`doctor`、`validate`。保留失败版本和 registry 证据以便审计，不删除已发布 artifact。

GitHub tag/Release 只在发布后 smoke 全绿后创建，因此正常回滚不需要删除或移动 tag。若外部动作顺序被破坏，保留 tag 的提交身份，在 Release 中明确标记 withdrawn；源码修复使用新的 revert/fix commit，不重写 `main` 历史。
