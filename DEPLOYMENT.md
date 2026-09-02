# HappyClaw Linux 生产部署

本仓库所在的 Linux 主机就是 HappyClaw 生产机。代码目录为
`/home/windeng/workspace/happyclaw`，服务由 PM2 应用 `happyclaw` 管理，执行
`dist/index.js` 并监听 `*:3000`。Nginx 的
`/etc/nginx/conf.d/happyclaw.conf` 将公网入口
`https://happyclaw.strangeoutlier.com` 转发到 `127.0.0.1:3000`。

部署只能更新 Git 跟踪的代码、依赖和构建产物；`data/`、现有 `.env`、渠道凭据、
OAuth/Keychain 等运行凭据、PM2 与 Nginx 配置必须原样保留。

## 1. 前置条件与部署目标

直接在当前 Linux 主机执行，不需要 SSH 到其他机器：

```bash
cd /home/windeng/workspace/happyclaw
export HAPPYCLAW_DEPLOY_REMOTE='fork'
export HAPPYCLAW_DEPLOY_REF='codex/replace-with-remote-branch'
export HAPPYCLAW_EXPECTED_SHA='replace-with-full-commit-sha'
export HAPPYCLAW_PREVIOUS_SHA="$(git rev-parse HEAD)"
export HAPPYCLAW_PUBLIC_URL='https://happyclaw.strangeoutlier.com'
export HAPPYCLAW_AGENT_IMAGE='riba2534/happyclaw-agent:latest'
```

部署前必须满足：

- 目标提交已经推送到远程分支。
- 测试、类型检查、文档检查、Agent Runner 自检和生产构建已通过。
- 明确记录远程分支、完整提交 SHA 和回滚 SHA；不从未提交的工作树部署。
- 若 `container/` 或 Agent Runner 发生变化：已合入 `main` 时等待 `latest` 发布；部署尚未
  合入的远程分支时，用 GitHub Actions 的 `workflow_dispatch` 在精确 ref 上构建，并使用
  `riba2534/happyclaw-agent:git-<完整提交 SHA>`。分支构建不得推进公共 `latest`。

## 2. 只读预检与目标校验

工作树不干净时立即停止，不要 stash、覆盖或删除未知文件：

```bash
test -z "$(git status --porcelain)" || {
  git status --short
  echo 'Production worktree is not clean; deployment stopped.' >&2
  exit 1
}

printf 'Rollback commit: %s\n' "$HAPPYCLAW_PREVIOUS_SHA"
git fetch --prune "$HAPPYCLAW_DEPLOY_REMOTE" \
  "refs/heads/$HAPPYCLAW_DEPLOY_REF:refs/remotes/$HAPPYCLAW_DEPLOY_REMOTE/$HAPPYCLAW_DEPLOY_REF"
test "$(git rev-parse "$HAPPYCLAW_DEPLOY_REMOTE/$HAPPYCLAW_DEPLOY_REF")" = \
  "$HAPPYCLAW_EXPECTED_SHA"
test "$(git rev-parse HEAD)" = "$HAPPYCLAW_EXPECTED_SHA"

pm2 pid happyclaw
curl -fsS http://127.0.0.1:3000/api/health
```

所有者已明确选择不保留部署备份。部署期间不得运行 `make backup`，不得创建 SQLite
快照、完整运行数据归档或 `.env` 备份副本，除非所有者在未来明确撤销该策略。禁止运行
`make reset-init`、`git clean`、`git reset --hard`，也不要用带 `--delete` 的 rsync 同步
生产目录。

现有 `.env` 必须原地设置 `HAPPYCLAW_SKIP_MIGRATION_BACKUP=1`；它只关闭启动时的 schema
迁移快照，不得覆盖其他环境变量：

```bash
if grep -q '^HAPPYCLAW_SKIP_MIGRATION_BACKUP=' .env 2>/dev/null; then
  sed -i 's/^HAPPYCLAW_SKIP_MIGRATION_BACKUP=.*$/HAPPYCLAW_SKIP_MIGRATION_BACKUP=1/' .env
else
  printf '\nHAPPYCLAW_SKIP_MIGRATION_BACKUP=1\n' >> .env
fi
chmod 600 .env
```

## 3. 安装与构建

```bash
make install
NODE_OPTIONS=--max-old-space-size=1024 npm run build:all
docker pull "$HAPPYCLAW_AGENT_IMAGE"
```

构建失败时不要重启 PM2；旧进程仍使用此前的 `dist/`。修复并推送新提交后，从只读预检
重新开始。

若本次使用不可变分支镜像，只原地更新现有 `.env` 中的 `CONTAINER_IMAGE`，不得创建备份
副本或覆盖其他变量：

```bash
if grep -q '^CONTAINER_IMAGE=' .env 2>/dev/null; then
  sed -i "s|^CONTAINER_IMAGE=.*$|CONTAINER_IMAGE=$HAPPYCLAW_AGENT_IMAGE|" .env
else
  printf '\nCONTAINER_IMAGE=%s\n' "$HAPPYCLAW_AGENT_IMAGE" >> .env
fi
chmod 600 .env
```

## 4. 需要停服的配置迁移

只有变更说明明确要求时才执行离线迁移。先确认没有 HappyClaw Agent 容器正在运行，再短暂
停止 PM2；迁移脚本必须自行验证端口已关闭、SQLite 无 sidecar 且数据库未被占用。

当前 Opus 5 + High 配置迁移命令为：

```bash
docker ps --format '{{.ID}} {{.Names}} {{.Status}}'
pm2 stop happyclaw
npx tsx scripts/set-default-opus5.ts --apply
pm2 start happyclaw
```

该脚本不得创建任何备份，只可重置底层 SDK resume Session；聊天记录、Agent Profile、
Workspace Memory、渠道配置和文件必须保留。重复运行必须是无变更的幂等操作。

没有离线迁移时直接重启：

```bash
pm2 restart happyclaw
```

## 5. Linux 生产验证

```bash
curl --retry 30 --retry-connrefused --retry-delay 2 \
  -fsS http://127.0.0.1:3000/api/health

pm2 pid happyclaw
pm2 logs happyclaw --nostream --lines 120
lsof -nP -iTCP:3000 -sTCP:LISTEN
curl -fsS http://127.0.0.1:3000/api/config/appearance/public
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/auth/me)" = 401
curl -fsS "$HAPPYCLAW_PUBLIC_URL/api/health"
curl -fsS "$HAPPYCLAW_PUBLIC_URL/api/config/appearance/public"
```

本机 `/api/health` 与公网入口返回的 uptime 应属于同一 PM2 进程；若差异明显，先检查
Nginx/Cloudflare 路由，不得把其他主机的健康状态当作本次 Linux 部署成功。

随后完成与改动相关的真实测试并分别记录结果：

1. 确认 PM2 执行路径是本仓库的 `dist/index.js`，Git HEAD 等于预期 SHA。
2. 确认数据库 quick check、外键检查及目标运行配置均通过。
3. 确认已配置的飞书、QQ、微信等 IM 渠道在重启后重新连接。
4. 发起一个真实 Web Agent 回合；若本次涉及渠道，再完成对应 IM 收发，确认模型、推理档位、
   流式输出、文件访问和最终回执正常。
5. 检查公网入口 TLS、静态资源、登录页和 `/api/health` 均成功。
6. 检查启动后的日志没有未解释的 `WARN`、`ERROR` 或恢复失败。

源码测试通过不等于部署完成；以上 Linux 运行环境检查未通过时不得报告完成。

## 6. 回滚

应用代码或构建产物异常、且数据库仍兼容旧代码时，切回预检记录的提交：

```bash
git switch --detach "$HAPPYCLAW_PREVIOUS_SHA"
make install
NODE_OPTIONS=--max-old-space-size=1024 npm run build:all
pm2 restart happyclaw
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS "$HAPPYCLAW_PUBLIC_URL/api/health"
```

所有者选择不保留数据备份，因此数据库迁移后不存在数据恢复路径。若迁移导致旧代码
不兼容，应停止继续切换并以前向修复恢复服务，不得自行创建或恢复备份。回滚后重复第 5
节的健康检查与真实功能测试，并明确报告仅发生了代码回滚。
