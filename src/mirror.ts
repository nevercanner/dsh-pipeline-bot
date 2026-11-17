/**
 * 成员回话 → 群（**让成员的回复真的出现在群里**）。
 *
 * ── 这一层在修什么 ──────────────────────────────────────────────
 * 早先的群只把「人说的话」和「工具调用」写进群，成员被唤醒后干完活在**它自己的
 * 会话里**回复 —— 那段话永远进不了群。于是群里只剩组长在自说自话，
 * 看起来就是「组长的分身」，而不是一群人聊天。
 *
 * 做法：监听宿主 `session/event`（post-commit 的追加流），凡是**群成员会话**里
 * 落下的 `assistant/message`，抽出正文写进群（role=member），并镜像进群聊会话。
 * 这样群里的发言来自每个成员自己的上下文，而不是某个代理替他们转述。
 *
 * 去重：按 `sessionId:seq` 记账。宿主会话日志会重放/补写，没有这道账会把同一句话
 * 记两遍。只镜像真正的 assistant 文本，工具调用与空回复跳过。
 */

export interface MirrorDeps {
  ctx: any
  /** 某个会话属于哪些群（一个会话可能同时在多个群）。 */
  groupsOfSession(sessionId: string): Promise<string[]>
  /** 群聊会话 id（自身不镜像）。 */
  roomOfGroup(groupId: string): Promise<string>
  /** 记一条成员发言进群，并镜像进群聊会话。 */
  record(sessionId: string, groupId: string, text: string, seq: number): Promise<void>
  logger?: { info?(message: string): void; warn?(message: string): void }
}

const MAX_TEXT = 4000

/** 从 assistant/message 事件里抽正文；没有正文（纯工具调用）返回 undefined。 */
export function assistantTextOf(event: any): string | undefined {
  const blocks = event?.data?.message?.content
  if (!Array.isArray(blocks)) return undefined
  const parts: string[] = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text.trim())
    }
  }
  if (parts.length === 0) return undefined
  const text = parts.join('\n\n').trim()
  if (text === '') return undefined
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

export interface MirrorHandle {
  /** 已镜像的条目数（诊断用）。 */
  count(): number
  dispose(): void
}

/**
 * 安装镜像监听。
 *
 * 注意：`session/event` 是 emit（不是 waterfall），监听器不返回值、不阻塞；
 * 但我们要写群存储，所以内部用队列串行，避免同一轮多条消息交叉写。
 */
export function installMemberMirror(deps: MirrorDeps): MirrorHandle {
  const seen = new Set<string>()
  let mirrored = 0
  let queue: Promise<void> = Promise.resolve()

  const handle = (session: any, event: any): void => {
    if (event?.type !== 'assistant/message') return
    const sessionId = String(session?.header?.id ?? session?.id ?? '')
    if (sessionId === '') return
    const seq = Number(event?.seq ?? -1)
    const key = `${sessionId}:${seq}`
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > 4000) {
      // 有界：超了清一半，够用且不会无限涨
      const drop = [...seen].slice(0, 2000)
      for (const item of drop) seen.delete(item)
    }
    const text = assistantTextOf(event)
    if (text === undefined) return

    queue = queue
      .then(async () => {
        const groupIds = await deps.groupsOfSession(sessionId)
        if (groupIds.length === 0) return
        for (const groupId of groupIds) {
          const room = await deps.roomOfGroup(groupId)
          if (room !== '' && room === sessionId) continue // 群聊会话自己的输出不回灌
          await deps.record(sessionId, groupId, text, seq)
        }
        mirrored += 1
      })
      .catch((error) => {
        deps.logger?.warn?.(`[dsh-pipeline-bot] 镜像成员发言失败：${String(error)}`)
      })
  }

  if (typeof deps.ctx?.on !== 'function') {
    // 宿主没有事件总线时不拖垮装配：镜像能力缺席，其余功能照常
    deps.logger?.warn?.('[dsh-pipeline-bot] 宿主没有 ctx.on，成员发言镜像不可用')
    return { count: () => 0, dispose: () => {} }
  }
  const off = deps.ctx.on('session/event', handle)
  return {
    count: () => mirrored,
    dispose: () => {
      try {
        if (typeof off === 'function') off()
      } catch {
        /* 忽略 */
      }
    },
  }
}
