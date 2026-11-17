/**
 * 群聊会话 → 成员（**让「在群里说话」真的等于派活**）。
 *
 * ── 这一层在修什么 ──────────────────────────────────────────────
 * 群聊会话是宿主里的真会话，所以它自带一个 LLM：你在里面打字，它会用自己的模型
 * 回你一段话。那段话跟群成员毫无关系 —— 这就是「群像组长的分身」的第二个来源：
 * 你以为在跟群说话，其实在跟一个没有身份的会话说话。
 *
 * 做法：用 `agent/pre-step` waterfall 处理**群聊会话**的输入：
 *   1. 取出这次要进入 step 的用户正文（跳过插件自己灌入的镜像消息，否则无限循环）
 *   2. 解析 @，把消息按群的规则分派、**唤醒对应成员**
 *   3. 返回 `{kind:'enter', messages}` —— 让消息**真的落进会话日志**（这样群里看得见）
 *
 * ── 这里推翻过一个错误设计，记下来免得走回去 ──────────────────
 * 早先返回 `{kind:'reject'}`，本意是"群会话不跑模型"。实测（同一台宿主）：
 * reject 之后 turn 直接结束，`user/message` **一条都不写**——
 * 于是群消息全部消失在收件箱里，用户打开群聊会话看到的是空的，
 * 正确结论是「这个群聊根本没在群里」。
 *
 * 所以必须 enter。为了不让它变成"冒充发言的 agent"，另配一条 `agent/request`
 * 拦截（见 muteRoomModel）：把群会话的调用压成 maxTokens=1 / temperature=0，
 * 既不给它长回复的余地，也只花 1 个 token。
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

/**
 * 群消息镜像进群聊会话时加的正文前缀。
 *
 * 为什么需要：镜像是用 `sessionController.prompt` 写进去的（这样才会落成
 * 看得见的 user/message 事件），而 prompt 不携带自定义 source，所以分不出
 * 「这是群镜像」还是「人打的字」。用前缀区分，两件事都好办：
 *   · relay 跳过带前缀的消息 —— 否则会把镜像当成人说话，再派回给成员，无限循环
 *   · 人一眼能看出哪行是群消息
 */
export const MIRROR_PREFIX = '【群】'

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
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const text = block.text.trim()
      if (text === '') continue
      // 群镜像：不是人打的字，跳过（否则自我派活）
      if (text.startsWith(MIRROR_PREFIX)) continue
      parts.push(text)
    }
  }
  if (parts.length === 0) return undefined
  return parts.join('\n').trim()
}

/**
 * 把群聊会话的模型调用压到最小：`agent/request` waterfall 里改 config。
 *
 * 目的有两个：
 *   · 群会话不该替成员说话（不产生"分身"式长回复）
 *   · 每写一条群消息都要过一次请求，必须便宜（maxTokens=1、temperature=0）
 *
 * @returns 是否命中了群会话（诊断用）
 */
export function installRoomModelMute(deps: RelayDeps): { count(): number; dispose(): void } {
  let muted = 0
  const listener = async (payload: any, next: () => Promise<any>): Promise<any> => {
    try {
      const sessionId = String(payload?.agent?.id ?? '')
      if (sessionId !== '') {
        const groupId = await deps.groupOfRoom(sessionId)
        if (groupId !== undefined) {
          const config = await next()
          muted += 1
          return { ...config, maxTokens: 1, temperature: 0 }
        }
      }
    } catch (error) {
      deps.logger?.warn?.(`[dsh-pipeline-bot] 压制群会话模型调用失败：${String(error)}`)
    }
    return next()
  }
  if (typeof deps.ctx?.on !== 'function') return { count: () => 0, dispose: () => {} }
  const off = deps.ctx.on('agent/request', listener)
  return {
    count: () => muted,
    dispose: () => {
      try {
        if (typeof off === 'function') off()
      } catch {
        /* 忽略 */
      }
    },
  }
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
      // 放行：消息必须进 step，才会写成会话里看得见的 user/message。
      // 模型输出由 muteRoomModel 压到 1 个 token，不会变成"冒充发言人"。
      return next()
    } catch (error) {
      deps.logger?.warn?.(`[dsh-pipeline-bot] 群聊会话分派失败：${String(error)}`)
      // 分派失败时放行原消息，让用户至少能看到错误而不是被静默吞掉
      return next()
    }
  }

  if (typeof deps.ctx?.on !== 'function') {
    deps.logger?.warn?.('[dsh-pipeline-bot] 宿主没有 ctx.on，群会话输入分派不可用')
    return { count: () => 0, dispose: () => {} }
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
