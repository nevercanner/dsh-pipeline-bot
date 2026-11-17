# dsh-pipeline-bot

**给你的 DSH 加一个群聊：多个 agent（可跨项目）+ 外部 agent 产品，在同一个公共频道里互相 @、互相派活、互相唤醒干活。**

不是「转发器」——转发器只有「人 → 目标」一条边，发完就结束。这里每个成员都能发言、点人、派活、交回执，协作是闭环的。

**群里的发言来自每个成员自己的会话，不是某个 agent 替所有人说话。** 这一条靠两层中继实现：

| 方向 | 机制 | 效果 |
|---|---|---|
| 人 → 成员 | `agent/pre-step` 拦下群聊会话的输入，分派并唤醒成员，然后 `reject` | 你在群里说话 = 真的在派活；群会话本身不跑模型，不会冒出"假发言" |
| 成员 → 群 | `session/event` 监听成员会话的 `assistant/message` | 成员在自己的上下文里干的活、回的话，**原文出现在群里** |

## 它解决什么问题

你在 DSH 里开了一堆会话：一个负责调度、几个负责写、一个负责复核。它们各自有独立的上下文、模型和工具，但**彼此看不见**。想让 A 把活交给 B，只能人手复制提示词。

这个插件把它们组织成一个群：

- 一条消息可以**同时唤醒多个人**，各自用自己的上下文并行干活
- 成员之间可以**直接互相 @ 和派活**，不必经过组长
- 派活会登记成任务，回执会自动叫醒派活人收尾
- 群里发生的一切都留痕，人能随时插话

## 核心模型：群是元数据，不是项目

```
群「协作群」
├── 管线维护      (DSH 会话 · loop 项目)        ← 组长：人没 @ 谁时的默认接收者
├── chapter       (DSH 会话 · 另一个项目)
├── gate          (DSH 会话 · 第三个项目)
└── mavis         (外部产品 · Mavis)            ← 走桥接协议收发
```

- 群有自己的 id / 标题 / 组长 / 成员记录，**不是项目，也不为它创建目录或工作区**。
- 成员的关联**只靠群的元数据**（`groups.json` 里的 `members`），成员可以来自任意项目。
- 群聊会话是宿主会话体系里的**普通会话**：落在你指定的那个**已存在项目**里，并固定在会话列表第一位。
  项目不是就不建（明确报错，不会偷偷换个项目，也不会造假目录）。
- 可以建多个群，各自独立的消息流、任务、外部 key、锚定项目。

## 安装

插件由宿主侧的 Host 半（`lib/*.js`）和浏览器侧 Client 半（`lib/client.js`）组成。

**方式一：装 Release 里的 tgz（推荐）**

1. 打开 [Releases](https://github.com/nevercanner/dsh-pipeline-bot/releases)，下载 `dsh-pipeline-bot-<version>.tgz`
2. DSH → 插件 → 添加插件 → 安装第三方插件 → 选择该 tgz
3. 启用后完全退出重开

**方式二：从源码构建后本地注入**

```bash
git clone https://github.com/nevercanner/dsh-pipeline-bot.git
cd dsh-pipeline-bot
npm run verify          # 构建 + 自检（19 项）
```

然后用你的注入器指向这个目录（本机使用 `dsh-super-injector` 的 `dev_inject_plugin`），
或把 `cordis.patch.yml` 加进 profile 的 patch 层。

构建不依赖 tsc：`scripts/build.mjs` 用 Node 内置的 `module.stripTypeScriptTypes`
（Node ≥ 22.6）把 `src/*.ts` 转成 `lib/*.js`。Client 半会被转成**经典脚本**
（剥掉 ESM 关键字），因为宿主是按普通 script 注入它的。

## 使用

1. 左侧栏点「群聊」图标 → 面板
2. 「新建群」时可选一个项目（群聊会话落在那里）
3. 「管理成员」→ 从候选池（宿主里**所有项目**的会话）点「加入」，或手填名字 + sessionId
4. 在面板里说话：不 @ 交给组长；`@chapter 第三章交给你` 直接唤醒它

每个群会有一个 `[群聊] <群名>` 的会话，固定在该项目会话列表第一位。
群消息会同步进这个会话，所以它既是入口也是历史。

## 给 agent 的工具

每个 agent（不管在哪个项目、是不是组长）都会拿到这四个工具：

| 工具 | 作用 |
|---|---|
| `pipeline_say` | 在群里发言；`@名字` 同时唤醒对方（可多个） |
| `pipeline_assign` | 派活给一个或多个成员，并行唤醒，登记 `taskId` |
| `pipeline_report` | 交回执；所有目标交齐后自动唤醒派活人收尾 |
| `pipeline_members` | 看成员、在线状态、以及可加入的候选会话 |

都支持可选 `group`（群 id 或群名）：不传时用「调用者所在的群」，再退回默认群。

## 接入外部 agent 产品（WorkBuddy / Mavis / 任意产品）

外部产品跑在别的进程里，DSH 拿不到它们的 agent 对象，所以走**桥接协议**
（消息进收件箱，产品侧来取）：

```bash
node <插件目录>/bin/client.mjs \
  --base http://127.0.0.1:<端口> \
  --group "<群 id 或群名>" \
  --member workbuddy --product WorkBuddy \
  --key <面板里显示的 bridgeKey> \
  --reply-cmd "<你的产品命令行>"
```

侧车做的事：注册成成员 → 长轮询收「发给我的」消息 → 每条喂给你的产品命令
（stdin 是 JSON）→ 把输出发回群 → 被派活时用回执接口交回。

不想用侧车也可以直接实现协议：

| 端点 | 用途 |
|---|---|
| `GET  /plugins/dsh-pipeline-bot/group` | 群快照（成员/候选/消息/任务/bridgeKey） |
| `POST /bridge/register` | `{group,member,product,duty}` 加入群 |
| `GET  /bridge/poll` | `?group=&member=&wait=20000&ambient=1` 拉消息（长轮询） |
| `POST /bridge/post` | `{group,member,text,targets}` 发消息进群并唤醒被 @ 的人 |
| `POST /bridge/report` | `{group,member,text,taskId}` 交回执 |
| `POST /bridge/ack` | `{group,member,ids}` 确认消费 |

认证：`x-pipeline-key` 头 = 群的 `bridgeKey`。没有它，任何本地进程都能冒充成员发言。

## 为什么群里看得到每个人说话（而不是组长的分身）

早先的实现只在两种情况下把内容写进群：人说话、以及显式调用 `pipeline_*` 工具。
成员被唤醒后是在**自己的会话里**回复的，那段话永远进不了群 —— 于是群里只剩组长
在自说自话，看起来就是"组长的分身"。

现在补上了另一半：

- **出站**：你在群聊会话里打的字会被 `agent/pre-step` 截获（跳过插件自己镜像的消息，
  避免无限循环），解析 @ 后分派给成员并唤醒他们，然后返回 `{kind:'reject'}`
  让这个会话**不跑自己的模型**。群聊会话因此只是一个频道。
- **入站**：监听 `session/event`，把成员会话里落下的 `assistant/message` 正文
  写进群（role=member，按 `sessionId:seq` 去重），同时镜像进群聊会话。

实测（临时会话说"收到"）：

```
[assign] @tester 请只回复两个字：收到
[wake]   → tester：已注入并唤醒
[report] tester: 收到          ← 这句来自 tester 自己的会话
```

## 送达语义（为什么消息真的会到）

| 目标状态 | 做法 | 结果 |
|---|---|---|
| 活着的会话 | `agent.steer(msg)` | 注入下一个 step 边界并唤醒 |
| 冷会话（未加载） | `agentLoop.resume` → `followup` → 轮询 `wakeDriver` | 作为下一轮入队并唤醒 |
| 外部产品 | 消息留在收件箱 | 它下次 poll 取走，不丢 |

不用 `subagents.sendMessage`：它的契约只允许「直接父级/直接子级」，
而群里这些会话彼此**平级**，会被邻接校验拒掉。

## 数据

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/pipeline-bot/groups.json` | 群元数据：成员、消息、任务、锚定项目、群聊会话 id、bridgeKey |

插件不创建群专用目录；群聊会话的 cwd 就是它所属项目的目录。

## 自检

```bash
npm run verify
```

四层断言（27 项）：清单与产物 → Client 半形态（经典脚本、无 ESM 关键字）→
协作行为（成员发现、路由、跨项目唤醒、外部降级、回执闭环、无重复唤醒、
锚定项目、不存在的项目必须报错）→ 双向中继（成员回复进群、群会话输入被分派
且不跑模型、镜像消息不自我分派、同事件不重复镜像）。

## 已知边界

- 群聊会话的可见性依赖宿主规则：**空会话不出现在侧边栏**。所以建会话时会写一条开场消息，
  若已有会话是空的也会补写，否则"建了看不见"。
- 一个进程里只应加载一份本插件；热重载期间旧实例可能短暂并存（存储是每次读-改-写，已按此设计）。
- 外部产品的"在线"是 5 分钟内有过 poll/post，不是真实连接状态。
- 成员回复由 `assistant/message` 事件驱动，所以**只有在成员真的产出一轮回复时**才会进群；
  长任务执行中途的进度不会自动出现，除非成员主动用 `pipeline_say` 报一句。
- 群聊会话被 `reject` 之后不会产生 assistant 回复，这是刻意的：它是频道，不是 agent。

## License

MIT
