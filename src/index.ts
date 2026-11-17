/**
 * @dsh-external/dsh-pipeline-bot — host 半。
 *
 * ── 它是什么 ──────────────────────────────────────────
 * **通用群聊**：一个群里可以坐着任意多个 DSH 会话（来自任意项目）+ 任意外部
 * agent 产品（WorkBuddy / Mavis / …）。它们在同一个公共频道里互相 @、互相派活，
 * 并且**真的把对方唤醒**去干活。
 *
 * 三个刻意的设计决定：
 *
 *   ① **群不绑项目**。群是全局一等实体（有自己的 id/标题/组长/成员），
 *      项目只是「候选成员来源」与成员的展示标签。这样 A 项目的会话可以
 *      在同一群里指挥 B 项目的会话 —— 跨项目协作才表达得出来。
 *
 *   ② **每个成员都有 pipeline_\* 工具**。谁都能发言、@ 人、派活、交回执，
 *      不必经过组长；组长只是「人没 @ 谁」时的默认接收者。
 *      这是「多 agent 协作」与「单向转发器」的分界。
 *
 *   ③ **送达即唤醒**。活会话 steer、冷会话 resume+followup+wakeDriver、
 *      外部产品进收件箱（等它 poll）。三条路都保留，因为三者的在线语义不同。
 *
 * ── 开关 ────────────────────────────────────────────
 *   ① profile patch 的 enabled —— 插件自身允许工作
 *   ② 群成员是**显式加入**的 —— 加入本身就是意图声明，不再需要项目级开关
 */
import { GroupBus, normalizeName } from './bus.ts'
import { collectNames } from './discovery.ts'
import { registerRoutes } from './routes.ts'
import { registerBusTools } from './tools.ts'
import * as store from './store.ts'
import type { Member } from './types.ts'
import { resolveService } from './util.ts'

export const name = '@dsh-external/dsh-pipeline-bot'
export const description =
  '通用群聊调度台：任意项目的 DSH 会话与外部 agent 产品（WorkBuddy / Mavis / …）在同一个群里互相 @、' +
  '互相派活、互相唤醒干活。左侧栏入口 + 群聊面板 + 外部产品桥接。'

export const inject = ['tools']

export interface Config {
  enabled?: boolean
}

interface Identity {
  name: string
  role: 'lead' | 'member'
  sessionId: string
}

export function apply(ctx: any, config: Config = {}): void {
  const log = {
    info: (message: string) => {
      try {
        ctx.logger?.info?.(`[dsh-pipeline-bot] ${message}`)
      } catch {
        /* 日志失败不影响功能 */
      }
    },
    warn: (message: string) => {
      try {
        ctx.logger?.warn?.(`[dsh-pipeline-bot] ${message}`)
      } catch {
        /* 同上 */
      }
    },
  }

  // bus 缓存：一个群一个实例；群标识可以是 id 或标题
  const buses = new Map<string, GroupBus>()

  /** 把「群标识（id / 标题 / 空）」解析成真实群 id。 */
  const resolveGroupId = async (ref: string | undefined): Promise<string> => {
    const wanted = (ref ?? '').trim()
    if (wanted === '') return (await store.defaultGroup()).id
    const groups = await store.listGroups()
    const exact = groups.find((item) => item.id === wanted)
    if (exact !== undefined) return exact.id
    const byTitle = groups.find((item) => normalizeName(item.title) === normalizeName(wanted))
    if (byTitle !== undefined) return byTitle.id
    const fuzzy = groups.find((item) => normalizeName(item.title).includes(normalizeName(wanted)))
    if (fuzzy !== undefined) return fuzzy.id
    return (await store.defaultGroup()).id
  }

  const busFor = async (ref?: string): Promise<GroupBus> => {
    const groupId = await resolveGroupId(ref)
    const existing = buses.get(groupId)
    if (existing !== undefined) return existing
    const bus = new GroupBus({ ctx, groupId, logger: log })
    buses.set(groupId, bus)
    return bus
  }

  /**
   * 调用者身份：session id → 群成员名。
   * 优先用「它在当前群里登记的名字」；不在群里就用会话标题（截断），
   * 至少让它在群里有可辨认的名字，而不是记成 unknown。
   */
  const identityIn = async (exec: any, bus: GroupBus): Promise<Identity> => {
    const sessionId = String(exec?.agent?.id ?? '')
    if (sessionId !== '') {
      const group = await bus.group()
      const record = group.members.find((member) => member.sessionId === sessionId)
      if (record !== undefined) {
        return { name: record.name, role: record.role === 'lead' ? 'lead' : 'member', sessionId }
      }
    }
    let title = ''
    try {
      title = String(exec?.agent?.session?.header?.title ?? '')
    } catch {
      title = ''
    }
    const names = await collectNames(ctx).catch(() => new Map<string, string>())
    const selfName = sessionId === '' ? undefined : names.get(sessionId)
    const group = await bus.group()
    const fallback = selfName ?? (title.trim() === '' ? `会话${sessionId.slice(0, 8)}` : title.trim().slice(0, 14))
    return {
      name: fallback,
      role: normalizeName(fallback) === normalizeName(group.leadName) ? 'lead' : 'member',
      sessionId,
    }
  }

  // ── 工具：每个 agent 都能用（多 agent 协作的实现面）──
  const mountTools = (): void => {
    let tools: any
    try {
      tools = ctx.tools
    } catch {
      tools = resolveService<any>(ctx, 'tools')
    }
    if (typeof tools?.register !== 'function') {
      log.warn('宿主没有 tools 服务，pipeline_* 工具不可用（面板仍可用）')
      return
    }
    const disposers = registerBusTools({
      tools: tools as any,
      busForCaller: async (exec: any, group?: string) => busFor(group ?? (await busForForCaller(exec))),
      identityOfCaller: async (exec: any, bus: GroupBus) => identityIn(exec, bus),
      logger: log,
    })
    log.info(`pipeline_* 工具已注册 ${disposers.length} 个`)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        for (const dispose of disposers) dispose()
      }, 'pipeline-bot: tools')
    }
  }

  /** 不指定群时：优先「调用者所在的群」，否则默认群。 */
  const busForForCaller = async (exec: any): Promise<GroupBus> => {
    const sessionId = String(exec?.agent?.id ?? '')
    if (sessionId !== '') {
      for (const item of await store.listGroups()) {
        const group = await store.getGroup(item.id)
        if (group.members.some((member) => member.sessionId === sessionId)) {
          return busFor(item.id)
        }
      }
    }
    return busFor(undefined)
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], mountTools)
  } else {
    mountTools()
  }

  // ── HTTP：面板 + 外部产品桥接 ──
  registerRoutes({
    ctx,
    busFor: (group?: string) => busFor(group),
    currentProject: () => {
      try {
        const agents = resolveService<any>(ctx, 'agents')
        const initiator = agents?.currentInitiator?.()
        const cwd = initiator?.session?.header?.cwd
        return typeof cwd === 'string' ? cwd : undefined
      } catch {
        return undefined
      }
    },
    statusOf: async (group?: string) => {
      const bus = await busFor(group)
      const snapshot = await bus.members()
      return {
        ok: true,
        installed: true,
        group: { id: snapshot.group.id, title: snapshot.group.title, leadName: snapshot.group.leadName },
        members: snapshot.members.length,
        candidates: snapshot.candidates.length,
        roomSessionId: snapshot.group.roomSessionId ?? '',
        bridgeKey: snapshot.group.bridgeKey,
      }
    },
    logger: log,
  })

  log.info('装配完成（通用群聊；群成员显式加入；外部产品走 bridge 协议）')
}

export type { Member }
