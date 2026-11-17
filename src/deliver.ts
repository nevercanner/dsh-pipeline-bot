/**
 * 跨会话投递：把一条消息**推进某个目标会话并唤醒它**。
 *
 * 这是整个插件的发动机。机制与结论来自 dsh-session-send 在同一台宿主上的实测：
 *
 *   ctx.agents.get(sessionId) → 活 Agent
 *     agent.steer(msg)     注入下一步 + 唤醒（运行中的目标在下一个 step 边界看到）
 *     agent.followup(msg)  作为下一轮入队 + 唤醒
 *     agent.inject(msg)    只进位不进驱动
 *   send() 内部是 inbox.splice(target, Infinity, 0, [message]) —— 没有父子校验，
 *   所以平级会话之间可以互发（这正是群聊调度需要的；subagents.sendMessage 不行，
 *   它只允许直接父子）。
 *
 * 目标不在本进程时用 agentLoop.resume 冷启动它；冷启动后 steer 会因为过渡态
 * 被 wakeDriver 吞掉，所以那条路径改用 followup + 轮询 wakeDriver。
 *
 * 本文件只依赖 types + util，不认识群聊/存储实现。
 */
import { shortRandom } from './util.ts'

export type DeliveryMode = 'steer' | 'followup' | 'notify'

export interface DeliverResult {
  ok: boolean
  /** 目标是否在本进程内活着。 */
  live: boolean
  /** 实际做到的事。 */
  outcome: 'steered' | 'queued' | 'notified' | 'absent' | 'failed'
  detail: string
  sessionId: string
}

export interface DeliverOptions {
  ctx: any
  logger?: { info?(message: string): void; warn?(message: string): void }
}

function agentOf(ctx: any, sessionId: string): any {
  try {
    const agents = ctx?.get?.('agents') ?? ctx?.agents
    return agents?.get?.(sessionId)
  } catch {
    return undefined
  }
}

function defaultAgentOptions(ctx: any): { provider: string; model: string } | undefined {
  try {
    const service = ctx?.get?.('agentDefaultModel') ?? ctx?.agentDefaultModel
    const selection = service?.currentSelection?.()
    if (selection?.provider === undefined || selection?.model === undefined) return undefined
    return { provider: selection.provider, model: selection.model }
  } catch {
    return undefined
  }
}

/** 已经 live 但缺 provider/model 的 Agent（旧版冷启动留下的）就地补齐，否则下一轮立刻报错。 */
function ensureModel(ctx: any, agent: any): void {
  try {
    const options = agent?.options
    if (options === undefined || options === null) return
    if (options.provider !== undefined && options.model !== undefined) return
    const next = defaultAgentOptions(ctx)
    if (next === undefined) return
    options.provider = next.provider
    options.model = next.model
  } catch {
    /* 读不到就跳过 */
  }
}

async function buildMessage(text: string, sender: { id?: string; name?: string }): Promise<any> {
  const content = [{ type: 'text', text }]
  const source: Record<string, unknown> = {
    kind: 'user',
    origin: 'dsh-pipeline-bot',
    from: sender.id ?? 'dsh-pipeline-bot',
  }
  if (sender.name !== undefined && sender.name !== '') {
    source['fromName'] = sender.name
  }
  // 优先用宿主的 createUserMessage（做 deepFreeze + 稳定 id）；拿不到就退化成同形状对象
  try {
    const module = await import('@deepseek-ai/dsh-llm')
    const factory: any = (module as any)?.createUserMessage
    if (typeof factory === 'function') {
      return factory({ source, content, id: shortRandom('msg') })
    }
  } catch {
    /* 宿主可解析时走上面；解析不到用下面的退化形状 */
  }
  return {
    id: shortRandom('msg'),
    role: 'user',
    source,
    content,
    time: Date.now(),
  }
}

async function resumeAgent(
  options: DeliverOptions,
  sessionId: string,
): Promise<{ agent?: any; error?: string }> {
  const loop = (() => {
    try {
      return options.ctx?.get?.('agentLoop') ?? options.ctx?.agentLoop
    } catch {
      return undefined
    }
  })()
  if (typeof loop?.resume !== 'function') {
    return { error: '宿主未提供 agentLoop.resume，无法冷启动目标会话' }
  }
  try {
    const agentOptions = defaultAgentOptions(options.ctx)
    const handle = await loop.resume(options.ctx, {
      resumeSessionId: sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions }),
    })
    const agent = handle?.agent ?? handle
    if (agent === undefined || agent === null) return { error: '冷启动返回空句柄' }
    return { agent }
  } catch (error) {
    return { error: `冷启动失败：${String(error)}` }
  }
}

/** 反复叫 wakeDriver，直到它真的离开 idle（冷启动后的过渡态会把第一次唤醒吞掉）。 */
async function wakeUntilRunning(agent: any, attempts = 8, intervalMs = 150): Promise<boolean> {
  if (typeof agent?.wakeDriver !== 'function') return false
  for (let index = 0; index < attempts; index += 1) {
    try {
      agent.wakeDriver()
    } catch {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    try {
      if (agent.phase?.kind !== 'idle') return true
    } catch {
      /* phase 读不到就继续试 */
    }
  }
  return false
}

/**
 * 投递一条消息。
 *
 * @param mode steer（默认，注入并唤醒）/ followup（下一轮入队并唤醒）/ notify（只入箱）
 */
export async function deliver(
  options: DeliverOptions,
  sessionId: string,
  text: string,
  mode: DeliveryMode = 'steer',
  sender: { id?: string; name?: string } = {},
): Promise<DeliverResult> {
  const target = String(sessionId ?? '').trim()
  if (target === '') {
    return { ok: false, live: false, outcome: 'failed', detail: '缺少目标会话 id', sessionId: target }
  }
  if (String(text ?? '').trim() === '') {
    return { ok: false, live: false, outcome: 'failed', detail: '消息正文为空', sessionId: target }
  }

  let agent = agentOf(options.ctx, target)
  let resumed = false
  if (agent === undefined) {
    const result = await resumeAgent(options, target)
    if (result.agent === undefined) {
      return {
        ok: false,
        live: false,
        outcome: 'absent',
        detail: result.error ?? '目标会话不在本进程且无法冷启动',
        sessionId: target,
      }
    }
    agent = result.agent
    resumed = true
    options.logger?.info?.(`[dsh-pipeline-bot] 冷启动会话 ${target}`)
  } else {
    ensureModel(options.ctx, agent)
  }

  const message = await buildMessage(text, sender)
  try {
    if (mode === 'notify') {
      if (typeof agent.inject === 'function') agent.inject(message)
      else agent.send(message, 'next-step', false)
      return {
        ok: true,
        live: true,
        outcome: 'notified',
        detail: resumed ? '已冷启动，消息入箱未唤醒' : '已入箱，未唤醒',
        sessionId: target,
      }
    }

    if (resumed) {
      // 冷启动后 steer 会被过渡态吞掉：followup 进下一轮队列，再显式顶驱动
      if (typeof agent.followup === 'function') agent.followup(message)
      else agent.send(message, 'next-turn', true)
      const woken = await wakeUntilRunning(agent)
      return {
        ok: true,
        live: true,
        outcome: 'queued',
        detail: woken ? '已冷启动并唤醒（下一轮执行）' : '已冷启动，消息在队列中（唤醒未生效）',
        sessionId: target,
      }
    }

    if (mode === 'followup') {
      if (typeof agent.followup === 'function') agent.followup(message)
      else agent.send(message, 'next-turn', true)
      return { ok: true, live: true, outcome: 'queued', detail: '已作为下一轮入队并唤醒', sessionId: target }
    }

    if (typeof agent.steer === 'function') agent.steer(message)
    else agent.send(message, 'next-step', true)
    return { ok: true, live: true, outcome: 'steered', detail: '已注入并唤醒', sessionId: target }
  } catch (error) {
    options.logger?.warn?.(`[dsh-pipeline-bot] 投递到 ${target} 失败：${String(error)}`)
    return {
      ok: false,
      live: true,
      outcome: 'failed',
      detail: `投递失败：${String(error)}`,
      sessionId: target,
    }
  }
}

/** 只查活着没有（面板用来标 live / inactive）。 */
export function isLive(ctx: any, sessionId: string): boolean {
  return agentOf(ctx, sessionId) !== undefined
}
