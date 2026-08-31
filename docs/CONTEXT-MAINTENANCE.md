# Context v2 使用与维护

本实例把长期上下文拆成四类权威来源，避免同一条信息同时散落在 `CLAUDE.md`、rules、notes 和会话历史中。

## 内容分层

| 内容                           | 权威来源                 | 例子                                     |
| ------------------------------ | ------------------------ | ---------------------------------------- |
| Agent 身份、语气、稳定工作方式 | Agent Profile            | “称呼阿秋”“教学质量优先”                 |
| workspace 的短小长期信息       | Workspace Memory         | 班级现状、渠道偏好、决定、复盘经验、待办 |
| 长篇规范和模板                 | 托管 Skill `references/` | 出卷、PPT、作文批改、HSK 双语规范        |
| 一段对话的临时连续性           | Session                  | 当前任务材料、临时讨论和中间结果         |

优先级是：用户当前说明或当前文件 > 有效 Workspace Memory > reference。一次性要求和能从当前材料直接读取的事实不进入长期上下文。

## 迁移后的实例布局

### windeng

管理员默认 Agent 使用 `host_claude`，个人工程上下文继续来自宿主机 `~/.claude`。这里维护跨项目工作方式、工程规则、项目笔记和个人 skills；不要复制 aqiu 的用户画像或 aqiu Home Memory。windeng 的私聊渠道也使用独立 Session，不与 Web 主会话混用短期历史。

### aqiu

- aqiu Home、QQ 私聊和飞书私聊使用同一个 Home workspace、默认 Agent Profile、Memory 和知识库。
- Web、QQ 和飞书各自保留独立 Session（短期对话历史）；跨渠道需要长期共享的信息应进入 Memory，不依赖某个渠道的聊天历史。
- 默认 Agent Profile 保存教学助手身份、沟通方式、检查与交付工作流。
- aqiu Home Memory 保存短小且可能更新的长期信息。
- `knowledge-base` skill 保存详细教学方法，并通过 `references/INDEX.md` 按需读取。
- 旧 `rules/` 和 `notes/` 已迁入 skill references；session 根 `CLAUDE.md` 仅保留兼容说明。

## 怎么使用

### 普通任务

按原来方式在 Web、QQ 或飞书发消息即可。Agent 会先召回当前 workspace 的相关 Memory，再按知识库索引读取需要的规范，不需要在每次消息里重复全部偏好。

飞书的 `autoIsolateContext` 已对 windeng 和 aqiu 开启；QQ 私聊也已绑定独立 Session。不要为了“共享上下文”把私聊手工绑到 workspace 主会话，否则会破坏会话隔离；应使用 Profile、Memory 和 skill 共享长期上下文。

### 要求记住

可以直接说：

- “记住：这个班以后都用基础版和进阶版两份材料。”
- “把刚才的批改标准记为这个 workspace 的长期偏好。”
- “这只是本次要求，不要记住。”

Agent 应先判断是否稳定、可复用。短小信息写入 Memory；较长方法只提出应更新哪个 reference，不在运行时容器里直接改 Git。

### 查看或手工维护 Memory

1. 打开侧栏的“Workspace Memory”。
2. 选择 `aqiu Home` 或其他目标 workspace。
3. 搜索 canonical key 或内容，查看来源和版本。
4. 修改同主题原条目，不新建近义副本。
5. 信息失效时使用“忘记”；若是被新结论替代，优先保留版本关系并让旧条目退出 active 检索。

四种类型：

- `fact`：相对客观的事实或现状。
- `decision`：已经确认、后续应遵守的选择。
- `lesson`：复盘得到的稳定经验。
- `open_loop`：仍需跟进的事项；完成后应关闭或更新。

canonical key 要稳定且可读，例如 `aqiu.delivery.channel-policy`。不要用日期或随机编号创建同一主题的多个 key。

### 维护 Agent Profile

打开侧栏“智能体”，编辑对应默认 HappyClaw 的四个区块：

- Identity：是谁、服务谁、主要角色。
- Soul：价值判断、语气、质量取向。
- Agents：稳定工作流和协作方式。
- Tools：工具选择和“何时才算成功”的约束。

班级人数、当前学期、临时项目等不要放 Profile；它们属于 Memory。修改 Profile 会影响该 Agent 绑定的所有 workspace，保存前先确认作用范围。

### 维护 aqiu 的长篇知识库

源目录是 aqiu context Git 仓库中的 `skills-source/knowledge-base/`：

1. 先在 `references/INDEX.md` 找同主题文档。
2. 更新原 reference；只有主题确实独立时才新建。
3. 同步更新索引描述，说明触发场景。
4. 运行 skill 校验并检查 Git diff，不提交凭据、账号或运行时文件。
5. 提交并推送 aqiu context 仓库；新会话或重启后的容器会重新投影托管 skill。

`settings.json` 是运行时文件，windeng 和 aqiu 的 context 仓库都不再跟踪它。

## 每周审查任务

`aqiu context 每周审查` 每周日 04:00（Asia/Shanghai）在 aqiu Home 的隔离会话中运行。它只读检查：

- Memory 的重复、冲突、过期时间性事实和未关闭待办；
- reference 索引失配或重复主题；
- Profile、Memory、reference 之间边界错放。

任务不会自动修改 Memory/Profile/文件，不执行 Git，也不向 QQ、飞书或邮件外发。建议在任务记录中查看，再由交互式主会话确认和应用。

## 维护节奏

### 每次纠正后

先完成当前任务，再判断是否稳定复用：一次性反馈不记；稳定短信息更新 Memory；长篇流程更新 reference；身份或长期工作方式才改 Profile。

### 每月

- 查看 active Memory 是否有近义重复。
- 核对时间性 `fact` 和 `open_loop`；完成项及时关闭。
- 检查知识库索引链接及近期新增规范是否归类正确。
- 检查 Profile 是否变成长篇知识库；若是，把细节下沉到 reference。

### 升级前

备份主仓库 dirty diff、两个 context 仓库 bundle、SQLite 在线快照和关键 `data/` 运行文件。先在数据库副本上验证 schema 迁移，再停服务迁移线上库。不要手工复制 SQLite 主文件来替代在线备份，也不要删除仍在使用的 WAL/SHM。

## 不要这样维护

- 不要把同一用户画像同时写进 Profile、CLAUDE.md 和多个 rules。
- 不要让定时任务自动“优化”长期记忆或直接提交 Git。
- 不要把渠道旧版本限制写成永远不变的能力事实。
- 不要在 Memory 或 context Git 仓库保存密码、令牌、身份证号、邮箱授权码等凭据。
- 不要用“清除上下文”代替 Memory 维护；清 Session 不会删除 Memory，而重建 workspace 会删除该 workspace 的全部 Memory。
