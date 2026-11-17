/**
 * 外部 agent 接入（WorkBuddy / Mavis / 以及你以后接的任何产品）。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────
 * DSH 内部的会话有 agent 对象，可以被 steer/followup 直接唤醒。
 * 但 WorkBuddy、Mavis 这类**别的产品**跑在别的进程里，DSH 拿不到它们的
 * agent，也就没法「推一条消息就让它跑起来」。它们没有统一的收消息 API
 * （实测：Mavis 只有本地 sqlite + 内嵌 UI，WorkBuddy 的 connect 插件只暴露模型）。
 *
 * 所以这里给它们一层**标准化的侧车协议**，两端各取所需：
 *
 *   产品侧（外部）：
 *     POST /plugins/dsh-pipeline-bot/bridge/post   { groupKey, member, text }
 *        → 它把话发进群，并唤醒该唤醒的 DSH 会话
 *     GET  /plugins/dsh-pipeline-bot/bridge/poll?groupKey=&member=&since=
 *        → 它拉「发给我的」消息（被 @ 的、派给它的、群里全部新消息）
 *     POST /plugins/dsh-pipeline-bot/bridge/ack    { groupKey, member, ids }
 *        → 确认消费到哪
 *
 *   插件侧（这里）：
 *     · 外部成员和其它成员一样出现在成员列表（role=external，带产品标签）
 *     · 群消息按「谁被 @ / 谁被派活」投进它的收件箱
 *     · 它发来的消息会唤醒 DSH 会话，等同于 DSH 成员发言
 *     · 投递失败（产品没在跑）→ 消息留在收件箱，等它下次 poll 取走，
 *       与内部会话「不在进程就落库」是同一条降级原则
 *
 * 认证：每个项目一个 bridgeKey（集群配置里，首次访问自动生成）。
 * 没有它，任何本地进程都能冒充成员发言 —— 这是必须的。
 *
 * 长轮询：poll 支持 wait=ms，外部产品用它做「准实时」，不必高频空转。
 */
import { randomBytes } from 'node:crypto'

export type ExternalInboxItem = {
  id: string
  ts: number
  /** 谁发的（成员名 / '我' / 'system'）。 */
  from: string
  role: string
  text: string
  /** 为什么进你的收件箱：mention（被 @）/ assign（被派活）/ ambient（群消息）。 */
  reason: 'mention' | 'assign' | 'ambient'
  taskId?: string
}

/** 每个 groupKey（= 项目）一份外部连接登记。 */
export interface ExternalLink {
  /** 成员名（群里 @ 的名字）。 */
  name: string
  /** 产品标签：workbuddy / mavis / 任意自由文本。 */
  product: string
  /** 可选职责描述。 */
  duty?: string
  /** 最近一次 poll/post 的时间。 */
  lastSeen?: number
  /** 收件箱游标：已消费到哪个时间点。 */
  cursor: number
}

export interface ExternalState {
  /** 产品名 → 连接清单。 */
  links: ExternalLink[]
  /** 已投递但还没 ack 的消息 id 集合（按成员名）。 */
  pending: Record<string, string[]>
}

export function newBridgeKey(): string {
  return `pb_${randomBytes(16).toString('hex')}`
}

/**
 * 从群消息里筛出「发给某个外部成员」的那部分。
 *
 * 三种进箱理由：
 *   mention —— 正文 @ 了他（或被显式列为 target）
 *   assign  —— 派活给他（kind=assign 且 targets 含他）
 *   ambient —— 其余群消息（外部产品通常也想看到上下文；可关）
 */
export function inboxFor(
  messages: readonly {
    id: string
    ts: number
    from: string
    role: string
    text: string
    kind: string
    taskId?: string
    targets?: string[]
  }[],
  memberName: string,
  since: number,
  options: { ambient?: boolean } = {},
): ExternalInboxItem[] {
  const wanted = memberName.trim().toLowerCase()
  const out: ExternalInboxItem[] = []
  for (const message of messages) {
    if (message.ts <= since) continue
    if (message.from.trim().toLowerCase() === wanted) continue // 自己发的不回灌
    const targeted = (message.targets ?? []).some((name) => name.trim().toLowerCase() === wanted)
    const mentionedInText = new RegExp(`[@＠]\\s*${escapeRegExp(memberName)}(?![\\w\\u4e00-\\u9fa5])`, 'i').test(message.text)
    const isAssignToMe = message.kind === 'assign' && targeted
    const reason: ExternalInboxItem['reason'] | undefined = isAssignToMe
      ? 'assign'
      : targeted || mentionedInText
        ? 'mention'
        : options.ambient === true && message.role !== 'system'
          ? 'ambient'
          : undefined
    if (reason === undefined) continue
    out.push({
      id: message.id,
      ts: message.ts,
      from: message.from,
      role: message.role,
      text: message.text,
      reason,
      ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
    })
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
