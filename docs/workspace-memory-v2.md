# Workspace Memory v2

Workspace Memory v2 是 HappyClaw 的工作区长期知识层。它保存经过提炼、未来
Session 仍可复用的内容，并以 Workspace 作为唯一产品入口和权限边界。

## 产品边界

HappyClaw 的相关数据分成两个彼此独立的层次：

| 层次             | 用途                                     | 删除/忘记语义                    |
| ---------------- | ---------------------------------------- | -------------------------------- |
| Session 历史     | 一段对话的消息、工具轨迹与即时上下文     | 由 Session/消息管理功能单独处理  |
| Workspace Memory | 同一 Workspace 跨 Session 复用的提炼知识 | 忘记后不再检索，但保留修订审计线 |

因此：

- Memory 页面先选择 Workspace，只查询该 Workspace 的数据。
- Workspace Memory 不是用户全局 Profile，也不会在不同 Workspace 之间共享。
- Session、日期和任意文件路径不是 Memory 页面中的可浏览“记忆源”。
- 来源 Session 只用于回溯 provenance；忘记一条 Memory 不会删除 Session 或聊天
  历史。
- Workspace 文件仍通过文件功能管理，不能通过 Memory API 任意读取或改写。

## 知识类型

每条 Memory 必须属于以下一种类型：

| Kind        | UI 名称 | 含义                                   |
| ----------- | ------- | -------------------------------------- |
| `fact`      | 事实    | 工作区中稳定、可验证的信息             |
| `decision`  | 决策    | 已经做出的选择及必要背景               |
| `lesson`    | 经验    | 可复用的做法、反例或教训               |
| `open_loop` | 待跟进  | 尚未关闭的问题、承诺、风险或下一步行动 |

Memory 应保存结论和必要上下文，而不是复制整段聊天。可复用知识不足时，保留在
Session 历史中即可。

## 数据与一致性

Workspace Memory v2 的 canonical store 位于 HappyClaw SQLite 主数据库。每个
Workspace 有独立的 store revision，每个 item 有单独的 revision：

- 每次创建、编辑或忘记都会递增 item revision 和 store revision。
- 版本记录保存当时的值、`changeType`、actor 和 provenance，按新到旧读取。
- 编辑和忘记必须提交 `expectedRevision`，服务端用 compare-and-set 防止丢失更新。
- 发生 409 `revision_conflict` 时，客户端保留本地草稿，展示服务端当前 revision，
  由用户决定何时加载最新版。
- 忘记通过 `deleted` tombstone 和 `forget` 版本表达；活跃列表和 Runtime
  检索不再返回该条目，但审计历史仍存在。
- 创建、编辑和忘记可以携带稳定的 `idempotencyKey`。相同请求重试返回
  `replayed: true`；同一个 key 对应不同请求时返回
  `idempotency_conflict`。

`validFrom`、`validUntil` 和 `expiresAt` 用于控制知识的时间有效性；`importance` 和
`confidence` 的范围都是 0 到 1。详情字段与端点见 [API 文档](API.md#workspace-memory-v2)。

## 来源与隐私

每条 item 和 version 都带有 provenance：

- `sourceType`：服务端根据 Web 用户、Agent Runtime、定时任务或迁移流程生成。
- `sourceId`：可选的来源消息或运行标识。
- `sessionId`：可选的来源 Session 标识。
- `observedAt`：知识被观察到的时间，不等同于数据库写入时间。

客户端可以提交 `sourceId`、`sessionId` 和 `observedAt`，不能伪造
`sourceType` 或 actor。读取要求能够访问 Workspace，写入要求能够修改 Workspace；
未授权与不存在均返回 404，管理员也不能跨 owner 读取 Workspace Memory。

Agent Runtime 还按执行上下文收紧写权限：顶层交互式 Main/Runtime Session 可按
Workspace ACL 读写；Scheduled Run（group/isolated）和 SDK Task Sub-Agent
只能读取，不能创建、更新或忘记 Memory。

## Web 交互

Memory 页面采用 Workspace-first 流程：

1. 从 `/api/workspaces` 选择 Workspace，并在 URL 中保存
   `?workspace=<workspaceJid>`。
2. 加载活跃 item，总览事实、决策、经验和待跟进数量。
3. 搜索只在当前 Workspace 内执行；类别筛选可与搜索组合。
4. 详情展示来源 Session/来源 ID、观察时间、item revision、store revision 和修订
   时间线。
5. 有修改权限时可以创建、编辑和忘记；只读 Workspace 不显示可执行写操作。

空状态需要区分“没有 Workspace”“Workspace 尚无 Memory”和“搜索无结果”。请求
失败在当前区域展示并允许刷新，不能回退到旧文件源。移动端在列表和详情之间切换，
返回列表不改变 Workspace；输入控件都有可读 label，冲突和错误使用 `role=alert`
通知辅助技术。

### 并发编辑流程

1. 打开 item r2，保留该 revision 作为 `expectedRevision`。
2. 用户编辑本地草稿并 PATCH。
3. 若服务端仍为 r2，保存成功并返回新的 item/store revision。
4. 若服务端已变为 r3，返回 409；页面继续显示本地草稿和冲突信息。
5. 用户显式选择“加载服务端最新版”后，页面才用 r3 覆盖草稿。

页面不能在冲突后自动重发 PATCH，也不能悄悄合并或覆盖内容。

## 旧版迁移

路径式的用户全局、日期和文件 Memory 端点已经退役并返回 410。旧
`data/memory/` 内容可以保留用于备份、离线导出或显式迁移，但具有以下约束：

- Web 页面和 Runtime 不读取或写入旧文件。
- 旧内容不会自动暴露为 Workspace Memory。
- 迁移流程必须明确目标 Workspace、kind 和 provenance，并使用 v2 写入接口。
- 完成迁移后，SQLite 记录是唯一在线真相源，不能进行双写。

## 验收清单

- 所有 Memory 请求都使用 `/api/workspaces` 返回的 JID，未使用 `folder`。
- 用户只能看到当前 Workspace 的 Memory；切换 Workspace 会清空旧选择和草稿。
- 四种 kind 可总览、筛选、搜索、创建和编辑。
- 详情可回溯来源、时间、revision 和 versions。
- PATCH/DELETE 携带 `expectedRevision`；409 时本地草稿仍在。
- 忘记后活跃列表不再显示 item，来源 Session 历史仍存在。
- 只读 Workspace 无写操作，未授权资源不泄露存在性。
- UI 和 Runtime 均不调用旧 `/sources`、`/search`、`/file`、`/global` 端点。
