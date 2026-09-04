# cc-channel-octo 对齐 openclaw-channel-octo 功能矩阵

> 阶段一交付物（元任务 LOO-1）。本文只做**只读分析 + 对齐说明**，不含任何业务代码改动。
> 拆子单、写实现留待 owner 确认本矩阵之后（硬 gate）。

## 1. 分析基线（钉死 SHA，勿漂移）

| 仓库 | 角色 | SHA | 日期 |
|---|---|---|---|
| `Mininglamp-OSS/openclaw-channel-octo` | 只读功能参照（对齐来源） | `0edccf33c6461ceffb83c73ae833f95cac95384b` | 2026-09-02 |
| `BrDing-Rookie/cc-channel-octo`（fork，改造目标） | PR 终点 = fork（origin） | `1871c2558da8f49ff872f45136a967d748264473` | 2026-07-21 |

对齐方向：**单向**——把 openclaw 已有、cc 缺失的能力移植/改造进 cc。openclaw 只读，勿改勿推。

体量参考：openclaw `src/` ≈ 71k 行，cc `src/` ≈ 30k 行。

---

## 2. 架构差异总述（决定「移植」还是「改造」的根因）

两个仓库共享同一套 **Octo 传输层**（WuKongIM 二进制协议 socket + REST 客户端）——事实上 cc 的 `src/octo/*` 就是从 openclaw 逐字 fork 出来的，与 Agent 运行时无关。真正的差异在**上层运行时**：

| 维度 | openclaw-channel-octo | cc-channel-octo |
|---|---|---|
| Agent 运行时 | **OpenClaw runtime**（`openclaw/plugin-sdk/*`） | **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk` 的 `query()`） |
| 插件形态 | `defineBundledChannelEntry` 注册为 channel 插件 | 独立守护进程 / CLI（`cli.ts` + `BotManager`） |
| Agent 生命周期钩子 | `api.on('before_agent_run' \| 'before_tool_call' \| 'after_tool_call' \| 'model_call_started/ended' \| 'llm_output' \| 'agent_end' \| 'before_prompt_build' \| 'before_reset')` | **无 hook 系统**；只有 `query()` 返回的消息流迭代器 + 每个 tool_use 触发的 `onToolUse(name,input)` 回调 + 一次 `session_id` 上报 |
| 提示词注入 | `before_prompt_build` hook 动态前插 `[GROUP CONTEXT]`/persona | **冻结系统提示词**（preset + append），可变上下文走首轮 user message；靠 SDK session resume 维持历史 |
| 会话/子代理原语 | `sessionKey`/`runId`/`toolCallId`、`sessions_yield`/`sessions_spawn`、ACP `SessionBindingAdapter`、agent-event 流（thinking/lifecycle） | SDK session id resume、`sdk_sessions` 表、无 ACP、无子代理暂停/续跑原语 |
| 派发 | `core.channel.reply.dispatchReplyWithBufferedBlockDispatcher`（media/tool/final/block 分类投递） | `StreamRelay`（累积文本流 + 自然边界切分 + 打字机心跳） |

**由此得出处置判据：**

- **可直接移植**：纯函数 / 无运行时耦合的层——卡片构建器与脱敏引擎、REST 客户端方法、mention 工具、目标解析、事件轮询循环、doc 任务 prompt 文本、密钥文件越狱逻辑。这些只依赖 Octo wire 契约与协商能力集。
- **需改造**：依赖 OpenClaw hook / ACP / agent-event / 子代理原语的层——进度卡片状态机、推理过程捕获、persona `before_prompt_build` 注入、`/fork` 转录继承、卡片动作回 turn 分发。改造 = 在 SDK 的「`query()` 流 + `onToolUse` 回调 + 冻结提示词 append」表面上重建等价能力。
- **建议跳过**：纯 OpenClaw 运行时内部、Claude SDK 无对应概念且 cc 已有等价物的——ACP 线程绑定适配器、`openclaw channels add` setup wizard、buffered block dispatcher 具体实现、子代理 yield/resume 暂停机制。

---

## 3. 两边功能清单概览

### openclaw 有、cc 缺（对齐候选）
- 卡片消息全家桶：能力协商、显示卡片、交互卡片、渲染管线+脱敏、事件轮询、进度卡片、推理过程展示、卡片动作回调
- Agent 主动消息动作：`octo_management` 聚合工具、主动发送到任意频道、跨频道读取、共享群搜索、命名目标解析、群/成员管理、子区加入/离开、space 成员搜索、voice-context CRUD、write-secret
- 出站富媒体：图片/文件发送、富文本图文混排（type 14）、后端无关预签名上传
- 文档评论 @Bot 任务（doc-mention 全链路 + doc 评论出站 + egress 护栏）
- Persona 分身 / OBO（obo-grant 拉取 + persona 注入 + OBO v2 中继信封）
- 服务端两轴免@偏好（`mention_pref` + `mention_pref_updated` 事件）
- `/fork` 子线程会话分叉、ACP 线程绑定
- 权限校验 + 审计日志模块
- 内置技能：`octo-bot-api`、`octo-card-message`

### 两边基本对齐（无需移植）
- WuKongIM 二进制协议 socket + 重连退避 + 心跳（cc 从 openclaw fork）
- REST 基础：sendMessage(文本)/typing/readReceipt/heartbeat/registerBot/getGroupMembers/fetchUserInfo/getChannelMessages
- 子区 channel-id 解析（`<groupNo>____<shortId>`）
- 入站内容解析（Text/Image/Voice/Video/File/RichText/MultipleForward）与媒体下载 SSRF 防护
- GROUP.md / THREAD.md 读写 + 变更事件失效（cc 用内存缓存，抗投毒，反而更严）
- 成员名册缓存 + robot 标记、入站 @name→uid 解析、出站 mention 解析
- 历史回填与「已答/新增」分段注入
- Bot 互答防循环、多 bot / 多账号
- URL policy / SSRF 防护、prompt-injection 结构化防御

### cc 独有（openclaw 无，不在对齐范围，仅备注勿删）
- Cron 定时任务 + `mcp__cron__*` 工具
- 三级令牌桶限流（全局/按用户/按会话×uid）
- SDK auto-memory、session resume、stale-resume 恢复、`/reset` 屏障
- 每会话 cwd 沙箱隔离 + TTL 清理

---

## 4. 全量对齐矩阵

图例：优先级 **P0**=前置基础设施 / **P1**=高价值主线 / **P2**=增强 / **P3**=可延后。
工作量 **S**≤0.5d · **M**1–2d · **L**3–5d · **XL**>1w（单人粗估，含测试）。

### A. 卡片消息（Cards）— 最大缺口域

| 功能模块 | openclaw 有 | cc 现状 | 差距描述 | 处置 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| A1 卡片能力协商 `getCardProfile`/`CardCaps` | ✓ 拉 `/v1/bot/card/profile` 清单，元素/输入/动作白名单 + limits，fail-closed | ✗ 无卡片能力发现 | 无法做任何卡片降级判断 | **移植**（纯 REST + 纯逻辑） | A9 | P0 | M |
| A2 卡片发送/编辑 REST `sendCardMessage`/`editCardMessage`/`sendTemplateCardMessage` | ✓ type17，octo/v1→v2 自动升档，`card_seq` CAS，`transient` | ✗ | 无卡片 wire 出口 | **移植**（纯 REST） | 无 | P0 | M |
| A3 卡片渲染管线 + 脱敏引擎 `card-render.ts`/`card-blocks.ts` + `card-render.corpus.ts` | ✓ DisplayBlock→Adaptive Card 1.5，线性脱敏（密钥/JWT/DSN/URL 收敛），预算裁剪，对抗性快照语料 | ✗ | 卡片不可见组成员安全渲染缺失 | **移植**（纯函数，含 corpus 快照一并迁） | 无 | P0 | L |
| A9 显示卡片工具 `octo_send_display_card` (`card-display-tool.ts`) | ✓ Agent 发非交互富卡（KPI/表格/可折叠/复制/链接），fail-closed 网关 | ✗（cc 只发纯文本） | Agent 无结构化展示能力 | **改造**（builder 纯移植；工具壳改为 SDK in-process MCP tool，身份恒为 bot） | A1,A2,A3 | P1 | L |
| A4 交互卡片工具 `octo_send_card` (`card-author.ts`/`card-tool.ts`) | ✓ Agent 发带 Submit 按钮/输入框的卡（确认/审批/菜单/表单） | ✗ | Agent 无交互确认能力 | **改造**（builder 纯移植；发送壳 SDK 化 + 注册卡会话） | A1,A2,A3,A5,A8 | P1 | L |
| A5 卡片事件轮询 `events-poll.ts` (`fetchBotEvents`/`ackBotEvent`) | ✓ 非重叠轮询/长轮询，游标持久化 + 去重，card_action/doc_mention/bot_setting 路由 | ✗ 无 events 端点客户端 | 卡片点击/doc 任务无入口 | **移植**（纯 REST + 循环，游标文件存储通用） | A2(events endpoints) | P0 | M |
| A8 卡片动作回调分发 `card-action-handler.ts` | ✓ 入站 `card_action`→查卡会话→校验身份→写回状态帧→重跑 agent turn（≤3 次死信） | ✗ | 交互卡按钮点击无处理 | **改造**（状态帧渲染纯移植；「重跑 turn」需接 cc 的 dispatch/session 派发） | A4,A5 | P1 | M |
| A6 进度卡片（实时状态卡）`card-progress.ts` | ✓ 由 hooks 驱动的状态机：thinking/tool/paused/answering/done，去抖编辑，限流冷却，子代理暂停/续跑 | ✗（cc 仅「🔧 Running tool…」文本通知） | 无实时可视进度 | **改造**（重度：openclaw 靠 8 个生命周期 hook；cc 需基于 `query()` 消息流 + `onToolUse` 重建状态机。子代理 yield/resume 暂停在 SDK 无原语 → 该子能力降级/跳过） | A1,A3,A2(editCardMessage) | P2 | XL |
| A7 推理过程展示 `reasoning-process.ts`（服务端 Registry 模板 `ai.reasoning-process`） | ✓ 步骤→phase→模板 wire，多级预算裁剪，思考文本 4 态分类/脱敏 | ✗ | 无「推理过程」原生卡 | **改造 / 部分跳过**（依赖服务端模板协商 + A6 状态；Claude SDK 有 thinking blocks 可作来源，但模板契约是 Octo 服务端专属） | A6,模板协商 | P3 | L |

### B. Agent 主动消息与频道管理

| 功能模块 | openclaw 有 | cc 现状 | 差距描述 | 处置 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| B0 权限校验 + 审计日志模块 `permission.ts`/`audit.ts` | ✓ 跨频道操作按请求者鉴权 + 审计 + 注入包装头 | ✗ 无权限/审计模块 | 主动发/跨频道读的安全前置缺失 | **移植/改造**（B2/B3 前置） | 无 | P1 | M |
| B1 `octo_management` 聚合工具 | ✓ 单工具 20+ action（list/info/members/md/thread/voice/secret/resolve/group-mgmt） | 部分：仅 GROUP.md/THREAD.md 更新（`mcp__group_md__*`/`mcp__thread_md__*`） | 缺群/子区/成员/命名解析等管理面 | **改造**（逐 action；多为纯 REST + SDK MCP 工具壳；多账号路由 + doc 任务门控随附） | B4–B10 各端点 | P1 | L |
| B2 主动发送到任意频道 `send` action | ✓ 目标解析 + mention 解析 + 富文本/多媒体分支 | ✗（cc 只回当前会话） | Agent 不能主动向其它群/人发消息 | **改造**（需 B0 权限+审计 + 目标解析 + 出站 mention 消毒） | B0,B5,C1/C2 | P1 | L |
| B3 跨频道读取 `read` action | ✓ 同频道/跨频道区分，跨频道需鉴权 + 审计 + 不可信内容包装 | ✗ | Agent 不能读其它频道历史 | **改造** | B0 | P2 | M |
| B4 共享群搜索 `search: shared-groups` + `fetchBotGroups`/`channel-list` | ✓ 返回请求者与 bot 的共享群；列全部 bot 群 | ✗（cc 无「列全部群」端点） | 无群发现能力 | **移植** | 成员缓存 | P2 | S |
| B5 命名目标解析 `resolveTargetsByName`/`resolve` action | ✓ 「转发给 XXX」→具体频道候选，强制消歧，30s TTL 缓存 | ✗ | 无人性化目标解析 | **移植**（REST）+ 工具壳 | B2 | P2 | M |
| B6 群管理 `createGroup`/`updateGroup`/`add/removeGroupMembers` | ✓ | ✗ | 无建群/改群/增删成员 | **移植**（纯 REST，User Bot only） | 无 | P2 | M |
| B7 子区管理补齐 `listThreadMembers`/`joinThread`/`leaveThread` | ✓ | 部分（cc 有 create/list/get/delete） | 缺 join/leave/成员列 | **移植** | 无 | P2 | S |
| B8 space 成员搜索 `searchSpaceMembers` | ✓ `/v1/bot/space/members` | ✗ | 无按名搜人 | **移植** | 无 | P3 | S |
| B9 voice-context CRUD `get/update/deleteVoiceContext` | ✓ owner 个人语音纠正上下文 | ✗ | 无该能力 | **移植** | 无 | P3 | S |
| B10 write-secret（密钥别名→越狱本地文件）+ `resolveSecret` | ✓ FS 越狱防护（`..`/符号链接/TOCTOU）+ 0o600，明文不出函数 | ✗ | Agent 无法安全落地凭据到本地文件 | **移植**（`resolveSecret` 纯 REST；FS jail 纯 Node；workspace 解析器需换成 cc 的 cwd/workspace 语义） | resolveSecret 端点 | P2 | M |

### C. 出站富媒体

| 功能模块 | openclaw 有 | cc 现状 | 差距描述 | 处置 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| C1 出站图片/文件发送 `sendMediaMessage` + 发送路径 | ✓ data/file/http 媒体，大小上限，流式落临时文件，图片尺寸解析 | ✗（cc `StreamRelay` 只发文本；有 STS 但无发媒体路径） | **Agent 完全不能发图片/文件** | **改造**（加出站媒体路径 + 附件/工具触发） | C3 | P1 | M |
| C2 富文本图文混排 `sendRichTextMessage`（type 14） | ✓ 单 payload 图文混排 | ✗ | 无图文混排出站 | **移植/改造** | C3 | P2 | M |
| C3 后端无关预签名上传 `getUploadPresign`/`uploadFileToPresignedUrl` | ✓ MinIO/COS/S3 通用，签名 Content-Length | 仅 COS STS `getUploadCredentials` | 上传绑定 COS，跨后端不可用 | **改造**（升级为预签名上传，保留 STS 兼容或替换） | 无 | P2 | M |

### D. 文档评论 @Bot 任务（doc-mention）

| 功能模块 | openclaw 有 | cc 现状 | 差距描述 | 处置 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| D1 doc-mention 全链路 `doc-mention.ts`/`doc-mention-handler.ts` | ✓ 解析事件→会话隔离 scope→合成 prompt（指向 octo-docs/octo-html 技能）→骑 inbound 派发→dedupe/deadletter/回退通知 | ✗ | 无「在文档里 @Bot 干活」能力 | **改造**（骑 cc 的 inbound 派发 + 出口重定向；cc 派发模型与 openclaw 不同，需适配 `docTask` 上下文透传） | A5,D2,D3 | P2 | XL |
| D2 doc 评论出站 `postDocComment`/`postHtmlDocReply` + 永久失败分类 | ✓ CRDT docs + octo-doc HTML，`final/progress/notice`→badge | ✗ | 无 doc 评论回写 | **移植**（纯 REST；`docsApiUrl` 配置项随附） | 无 | P2 | M |
| D3 doc 任务 egress fail-closed 护栏 | ✓ 被注入的 doc 评论不能驱动 bot 乱发 IM / 读写任意群 | ✗ | 缺横向越权防护 | **改造**（cc 需等价 egress 抑制 + 哨兵目标拦截） | D1 | P2 | M |

### E. Persona 分身 / OBO

| 功能模块 | openclaw 有 | cc 现状 | 差距描述 | 处置 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| E1 persona 提示注入 `persona-prompt.ts` + `getBotOboGrant` | ✓ 启动拉 obo-grant，60s 刷新，`composePersonaHint` 组分身身份 | ✗ | 无「以 XX 分身身份回复」 | **改造**（obo-grant 拉取 + compose 纯移植；注入点由 `before_prompt_build` 改为 cc 冻结提示词的 append 段，代次守卫随附） | getBotOboGrant 端点 | P2 | M |
| E2 OBO v2 中继信封（`obo_origin_channel_id`/`obo_respond_as`/`obo_system_hint`） | ✓ 仅信任配置的授权人，相关性过滤后回流到来源频道 | ✗ | 无 fan-out 中继链路 | **改造**（inbound 信封识别 + 回流路由，早返防状态污染） | E1,inbound 改造 | P3 | M |

### F. 触发/门控行为对齐

| 功能模块 | openclaw 有 | cc 现状 | 差距描述 | 处置 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| F1 服务端两轴免@偏好 `getMentionPref` + `mention_pref_updated` 事件 | ✓ 服务端权威 `no_mention`/`group_allow_no_mention`/`effective`，人类发送者才放宽 | 静态 `mentionFreeGroups` 配置列表 | 免@ 由本地配置而非服务端偏好，行为分叉 | **改造**（加 `getMentionPref` REST + 门控逻辑 + 事件失效） | 无 | P2 | M |

### G. 会话 / 线程高级

| 功能模块 | openclaw 有 | cc 现状 | 差距描述 | 处置 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| G1 `/fork` 子线程会话分叉 `commands/fork*.ts` | ✓ 建子线程 + 父转录继承（`ParentSessionKey` 触发 get-reply fork 父 transcript） | ✗ | 无「分叉一条支线对话」 | **改造**（OpenClaw 靠 ACP + get-reply 转录 fork；cc 需基于 SDK session resume 重设计：把父 `sdk_session_id` 复制/续接进子会话，配 `createThread`） | createThread(有),session-store,G2 | P3 | L |
| G2 ACP 线程绑定适配器 `thread-binding-adapter.ts` | ✓ 实现 OpenClaw ACP `SessionBindingAdapter`（current/child placement） | ✗ | — | **跳过**（纯 OpenClaw ACP 概念，Claude SDK 无 `SessionBindingAdapter`；若确需「Agent 绑定/创建子线程」可另做一个 cc MCP 工具，不照搬 ACP 机制） | — | 跳过 | — |

### H. 运行时 / 连接健壮性

| 功能模块 | openclaw 有 | cc 现状 | 差距描述 | 处置 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| H1 重连协调 / 看门狗 / 心跳解耦 `reconnect-coordination.ts`/`connection-watchdog.ts`/`heartbeat.ts` | ✓ 重连序列器 + 看门狗谓词 + single-flight + 心跳与 socket 解耦 | 已有：重连退避+抖动、快速断连→token 刷新、心跳代次守卫（较简） | 稳态基本可用，缺精细化编排 | **改造（可选硬化）** | 无 | P3 | M |

### I. 内置技能（Bundled Skills）

| 功能模块 | openclaw 有 | cc 现状 | 差距描述 | 处置 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|---|
| I1 内置技能 `skills/octo-bot-api`、`skills/octo-card-message` | ✓ 随插件下发，教 Agent 用 bot API + 卡片消息 | ✗（cc 有 SDK 技能发现机制但不含 octo 专用技能） | Agent 不知道如何用新移植的工具 | **移植/改造**（文档适配 cc 的工具名与 MCP 前缀 `mcp__*`） | 对应工具先落地（A9/A4/B1） | P2 | M |

### 跳过项汇总（runtime-specific，cc 不适用；写明理由）

| 项 | 跳过理由 |
|---|---|
| 插件入口 + hook 系统（`defineBundledChannelEntry`、`before_prompt_build`/`before_reset`/`api.on(...)`） | cc 用 SDK `query()` + 冻结提示词，机制不同；**不移植机制本身**，只在 E1/A6 中把「注入点/生命周期观测点」等价替换到 SDK 表面 |
| ACP 线程绑定适配器（G2） | Claude SDK 无 ACP `SessionBindingAdapter` 概念 |
| `openclaw channels add` setup wizard | cc 有独立 `cli.ts` + `configure` 子命令，安装路径不同 |
| buffered block dispatcher / reply delivery modes 的具体实现 | cc 用 `StreamRelay`，投递结果等价，无需照搬派发器 |
| 子代理 `sessions_yield`/`sessions_spawn` 暂停/续跑 | SDK 无对应原语；影响 A6 的暂停/续跑子能力（该子能力降级，不阻塞 A6 主体） |

---

## 5. 处置分类汇总

- **可直接移植（纯函数 / 纯 REST，低风险）**：A1、A2、A3、A5、B4–B9、B10(部分)、C2、D2 —— 迁过来主要是补 `octo/api.ts` 端点 + 迁纯逻辑文件 + 配套单测。
- **需改造（受 SDK/运行时差异约束）**：A9、A4、A8、A6、A7、B0、B1、B2、B3、C1、C3、D1、D3、E1、E2、F1、G1、H1 —— 核心工作量在「把 OpenClaw hook/ACP/派发耦合改建到 SDK 的 `query()` 流 + `onToolUse` + 冻结提示词 append」。
- **建议跳过（运行时专属）**：G2、插件 hook 机制本体、setup wizard、buffered dispatcher、子代理暂停原语。

---

## 6. 依赖拓扑（必须先做的前置项）

```
卡片链:  A2(卡片REST) ─┬─> A1(能力协商) ─┬─> A9(显示卡片工具)
                       │                 └─> A4(交互卡片工具) ─> A8(动作回调)
         A3(渲染/脱敏) ─┘                         ▲
         A5(事件轮询) ───────────────────────────┘ (交互卡回调 + doc任务 均依赖)
         A6(进度卡) 依赖 A1+A2+A3 ;  A7(推理过程) 依赖 A6

主动消息链: B0(权限/审计) ─> B2(主动发送) ; B2 ─> B5(命名解析)
            C3(预签名上传) ─> C1(发媒体) / C2(富文本) ;  C1 是 B2 富媒体分支的前置

Doc任务链: A5(事件轮询) + D2(doc出站) + D3(egress护栏) ─> D1(doc-mention全链路)

Persona链: E1(obo-grant+注入) ─> E2(OBO v2中继)

技能:      A9/A4/B1 落地后 ─> I1(内置技能文档)
独立:      F1(mention_pref)、G1(/fork)、H1(重连硬化) 无强前置
```

**关键前置**：`A2 + A1 + A3 + A5`（卡片四件套基础设施）解锁整个卡片域；`B0`（权限+审计）解锁主动消息域；`C3`（预签名上传）解锁富媒体域；`A5`（事件轮询）同时是卡片交互与 doc 任务的公共前置。

---

## 7. 总体差距结论

1. **cc 是「被动应答型」bot，openclaw 是「主动 + 富交互型」bot。** cc 目前只能在被 @ 的当前会话里回**纯文本**；它既不能发图片/文件/卡片，也不能主动向其它频道发消息或读取其它频道。这是最大的能力断层，集中在 A（卡片）、B（主动消息）、C（富媒体）三域。
2. **传输层已对齐，缺口全在「Octo 平台高级特性」的 REST + 上层编排。** cc 的 `octo/api.ts` 只覆盖了最基础的一组端点；卡片、事件轮询、mention_pref、OBO、预签名上传、resolve、群管理、voice、secret、doc 评论等端点全缺——这部分补齐是纯 REST 移植，风险低、见效快。
3. **真正的「改造」成本来自运行时差异，而非 Octo 协议。** 进度卡片（A6）、推理过程（A7）、doc 任务（D1）、persona 注入（E1）之所以是「改造」而非「移植」，是因为它们在 openclaw 里深度绑定 hook/ACP/子代理原语；迁到 cc 要在 SDK 的 `query()` 流 + `onToolUse` + 冻结提示词表面重建。**A6 与 D1 是全矩阵里最大的两块（XL）。**
4. **安全姿态需同步迁移，不能只迁功能。** openclaw 的卡片脱敏引擎（A3）、跨频道注入包装 + 审计（B0/B3）、doc egress 护栏（D3）、write-secret 越狱防护（B10）都是「卡片/主动消息可见于全群、可被 prompt 注入驱动」的直接防御。移植功能时**必须**连带移植对应防御，否则引入越权/泄密面。
5. **少量能力建议直接跳过**（G2 ACP、hook 机制本体等），cc 已有等价物或 SDK 无对应概念，强行照搬只会增加维护负担。

---

## 8. 建议分批开发顺序（供 owner 拆子单参考）

> 每批为一个可独立交付 + 可回退的里程碑；批内可并行，批间有依赖屏障（可用 `--stage` 表达）。

- **第 0 批（地基 · P0）**：`octo/api.ts` 端点补齐 —— A2、A1、A5，以及后续批要用的 REST（getMentionPref、getBotOboGrant、getUploadPresign、resolveTargetsByName、createGroup 系列、searchSpaceMembers、voice、resolveSecret、postDocComment/postHtmlDocReply、fetchBotGroups/getGroupInfo）。**纯移植，低风险，一次性把 wire 层拉齐。**
- **第 1 批（卡片可见价值 · P1）**：A3（渲染/脱敏 + corpus）→ A9（显示卡片工具）。让 Agent 先能发结构化富卡（状态/表格），收益最直观。
- **第 2 批（富媒体 · P1）**：C3（预签名上传）→ C1（发图片/文件）、C2（富文本）。补齐「发得出图/文件」这一基础断层。
- **第 3 批（交互 · P1）**：A4（交互卡片）+ A8（动作回调），依赖第 0/1 批。
- **第 4 批（主动消息 · P1）**：B0（权限+审计）→ B2（主动发送）+ B3（跨频道读）+ B1（`octo_management` 聚合）+ B4/B5/B6/B7（发现与管理）。
- **第 5 批（进度可视化 · P2）**：A6（进度卡片，XL，重改造）→ A7（推理过程，可延后）。
- **第 6 批（doc 任务 · P2）**：D2 + D3 → D1（XL）。
- **第 7 批（行为对齐 + 分身 · P2/P3）**：F1（mention_pref）、E1/E2（persona/OBO）、B8/B9/B10（space 搜人/voice/secret）。
- **第 8 批（收尾 · P2/P3）**：I1（内置技能文档，随工具落地）、G1（/fork）、H1（重连硬化）。

**总量粗估**：约 2 个 XL（A6、D1）+ 5–6 个 L + 十余个 M/S。地基 + 卡片 + 富媒体（第 0–3 批）是投入产出比最高、也是解锁其余一切的关键路径。

---

*阶段一分析完成。等 owner（于靖力）确认本矩阵后再进入阶段二（拆子单 / 写业务代码）。*
