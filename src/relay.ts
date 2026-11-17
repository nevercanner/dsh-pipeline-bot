/**
 * 群聊会话 → 成员（**让「在群里说话」真的等于派活**）。
 *
 * ── 这一层在修什么 ──────────────────────────────────────────────
 * 群聊会话是宿主里的真会话，所以它自带一个 LLM：你在里面打字，它会用自己的模型
 * 回你一段话。那段话跟群成员毫无关系 —— 这就是「群像组长的分身」的第二个来源：
 * 你以为在跟群说话，其实在跟一个没有身份的会话说话。
 *
 * 做法：用 `agent/pre-step` waterfall 拦下**群聊会话**的输入：
 *   1. 取出这次要进入 step 的用户正文（跳过插件自己灌入的镜像消息，否则无限循环）
 *   2. 解析 @，把消息按群的规则分派、**唤醒对应成员**
 *   3. 返回 `{kind:'reject'}` —— 不让这个会话跑模型
 * 于是群聊会话变成一个纯粹的**频道**：你说话 → 成员被叫醒 → 成员在自己的会话里
 * 干活 → 它的回复由 mirror.ts 送回群里。
 *
 * 为什么 reject 而不是 enter 一条空消息：空消息会让模型无事可做但仍计费一次请求；
 * reject 直接关掉这一步，群聊会话不再产生「假发言」。
 */

export interface RelayDeps {
  ctx: any
  /** 这个会话是不是某个群的群聊会话；是则返回群 id。 */
  groupOfRoom(sessionId: string): Promise<string | undefined>
  /** 把一段人在群里说的话分派给成员（内部走 bus.speak，会唤醒被 @ 的人）。 */
  dispatch(groupId: string, text: string): Promise<{ targets: string[] }>
  logger?: { info?(message: string): void; warn?(message: string): void }
}

/** 插件自己灌进会话的消息带这个来源，必须跳过（否则会自我分派、无限循环）。 */
const SELF_ORIGIN = 'dsh-pipeline-bot'

/** 取这次 step 里「人真正输入的」正文；跳过插件灌入的镜像消息。 */
export function humanTextOf(messages: readonly any[]): string | undefined {
  const parts: string[] = []
  for (const message of messages ?? []) {
    const origin = message?.source?.origin
    if (origin === SELF_ORIGIN) continue
    const kind = message?.source?.kind
    if (kind !== undefined && kind !== 'user') continue
    const blocks = message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        parts.push(block.text.trim())
      }
    }
  }
  if (parts.length === 0) return undefined
  return parts.join('\n').trim()
}

export interface RelayHandle {
  /** 已分派的条数（诊断用）。 */
  count(): number
  dispose(): void
}

export function installRoomRelay(deps: RelayDeps): RelayHandle {
  let dispatched = 0

  const listener = async (payload: any, next: () => Promise<any>): Promise<any> => {
    try {
      const sessionId = String(payload?.agent?.id ?? '')
      if (sessionId === '') return next()
      const groupId = await deps.groupOfRoom(sessionId)
      if (groupId === undefined) return next()

      const text = humanTextOf(payload?.messages)
      if (text !== undefined) {
        const result = await deps.dispatch(groupId, text)
        dispatched += 1
        deps.logger?.info?.(
          `[dsh-pipeline-bot] 群聊会话收到输入，已分派给 ${result.targets.join('、') || '（无人）'}`,
        )
      }
      // 群聊会话本身不跑模型：它是频道，不是 agent。
      // 若本轮只有插件自己灌入的镜像消息，同样 reject —— 免得产生无意义请求。
      return { kind: 'reject' } as const
    } catch (error) {
      deps.logger?.warn?.(`[dsh-pipeline-bot] 群聊会话分派失败：${String(error)}`)
      // 分派失败时放行原消息，让用户至少能看到错误而不是被静默吞掉
      return next()
    }
  }

  const off = deps.ctx.on('agent/pre-step', listener)
  return {
    count: () => dispatched,
    dispose: () => {
      try {
        if (typeof off === 'function') off()
      } catch {
        /* 忽略 */
      }
    },
  }
}
