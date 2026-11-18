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
import { GroupBus, normalizeName, wasRecentlyWoken } from './bus.ts'
import { collectNames } from './discovery.ts'
import { installMemberMirror } from './mirror.ts'

import { registerRoutes } from './routes.ts'
import { registerBusTools } from './tools.ts'
import * as store from './store.ts'
import type { Member } from './types.ts'
import { asText, resolveService } from './util.ts'

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
  const resolveGroupId = async (ref: unknown): Promise<string> => {
    // 模型可能把 group 参数传成对象/数组。这里必须先转文本 ——
    // 早先 `(ref ?? '').trim()` 直接抛 `(ref ?? "").trim is not a function`，
    // 表现为 pipeline_say / pipeline_members 两个工具同时"坏掉"。
    const wanted = asText(ref).trim()
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

  const busFor = async (ref?: unknown): Promise<GroupBus> => {
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
    // session id 自带 `session-` 前缀；直接 slice 会拼出「会话session-」这种名字
    const shortId = sessionId.replace(/^session-/, '').slice(0, 6)
    const fallback = selfName ?? (title.trim() === '' ? `会话${shortId}` : title.trim().slice(0, 14))
    return {
      name: fallback,
      role: normalizeName(fallback) === normalizeName(group.leadName) ? 'lead' : 'member',
      sessionId,
    }
  }

  // ── 工具：每个 agent 都能用（多 agent 协作的实现面）──
  /**
   * 挂工具。返回 disposer，由 `ctx.inject` 回调自己持有。
   *
   * 踩过的坑：早先把 `ctx.effect(() => () => dispose())` 写在 inject 回调**内部**，
   * 那个 effect 建在回调的瞬时作用域上，回调一返回就被回收 —— 工具刚注册就被拆掉。
   * 现象是「fiber 一直 active，但工具表里一个 pipeline_* 都没有」。
   * 正确做法：把 disposer 作为 inject 回调的返回值，生命周期跟着依赖作用域走。
   */
  const TOOL_NAMES = ['pipeline_say', 'pipeline_assign', 'pipeline_report', 'pipeline_members']

  /**
   * 挂工具。返回 disposer，由 `ctx.inject` 回调自己持有。
   *
   * ── 两次踩坑，都记在这里 ────────────────────────────────
   * ① 早先把 `ctx.effect(() => () => dispose())` 写在 inject 回调内部：
   *    那个 effect 建在回调的瞬时作用域上，回调一返回就被回收，工具刚注册就被拆掉。
   * ② 热重载时**新旧两个 fiber 会短暂并存**：新实例 register 撞上旧实例留下的同名工具
   *    → 注册抛错 → 新实例一个都没注册；随后旧 fiber 卸载把旧的也拆掉
   *    → 结果「reload 后 active，但工具表里 0 个」。
   *
   * 所以这里不能"注册一次就完"：注册后自检，缺了就用延时重试（等旧 fiber 先卸），
   * 并且只在名字确实缺失时才注册，避免自己和自己撞。
   */
  const mountTools = (): (() => void) => {
    let tools: any
    try {
      tools = ctx.tools
    } catch {
      tools = resolveService<any>(ctx, 'tools')
    }
    if (typeof tools?.register !== 'function') {
      log.warn('宿主没有 tools 服务，pipeline_* 工具不可用（面板仍可用）')
      return () => {}
    }

    let disposers: Array<() => void> = []
    let disposed = false
    const timers: Array<() => void> = []

    const presentCount = (): number => {
      let present = 0
      for (const name of TOOL_NAMES) {
        try {
          if (tools.get(name) !== undefined) present += 1
        } catch {
          /* 读不到算缺失 */
        }
      }
      return present
    }

    const releaseLocal = (): void => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 忽略 */
        }
      }
    }

    const registerFresh = (): boolean => {
      if (disposed) return true
      const fresh = registerBusTools({
        tools: tools as any,
        busForCaller: async (exec: any, group?: string) => busFor(group ?? (await busForForCaller(exec))),
        identityOfCaller: async (exec: any, bus: GroupBus) => identityIn(exec, bus),
        logger: log,
      })
      disposers.push(...fresh)
      const ok = presentCount() === TOOL_NAMES.length
      if (ok) log.info(`pipeline_* 工具已注册 ${fresh.length} 个`)
      return ok
    }

    /**
     * 自愈：一发现四个名字缺失就重挂。
     *
     * 为什么必须是**常驻**检查而不是挂载时重试几次：
     * 热重载里旧 fiber 的卸载时机不确定（可能在几秒后），早先只退避 4 次
     * （共约 5 秒）就放弃，于是「某次 reload 后工具整体消失、再也不回来」。
     * 这里每 5 秒看一次，缺一次补一次 —— 与 reload 时序彻底解耦。
     */
    const heal = (): void => {
      if (disposed) return
      try {
        if (presentCount() === TOOL_NAMES.length) return
        releaseLocal()
        registerFresh()
      } catch (error) {
        log.warn(`pipeline_* 自愈失败：${String(error)}`)
      }
    }

    // 立即挂一次；后面由看门狗兜住任意时刻的失效
    if (!registerFresh()) {
      for (const delay of [200, 600, 1500, 3000]) {
        const timer = setTimeout(heal, delay)
        if (typeof (timer as any)?.unref === 'function') (timer as any).unref()
        timers.push(() => clearTimeout(timer))
      }
    }
    const watchdog = setInterval(heal, 5000)
    if (typeof (watchdog as any)?.unref === 'function') (watchdog as any).unref()
    timers.push(() => clearInterval(watchdog))

    return () => {
      disposed = true
      for (const cancel of timers.splice(0)) {
        try {
          cancel()
        } catch {
          /* 忽略 */
        }
      }
      releaseLocal()
    }
  }

  /**
   * 双向中继：让群成为**真正的频道**，而不是组长的分身。
   *
   *   成员会话里的 assistant 回复 → 写进群（mirror.ts）
   *   群聊会话里人打的字       → 分派并唤醒成员（relay.ts）
   *
   * 两者合起来，群里看到的是每个成员各自说的话；群聊会话本身不跑模型。
   */
  const installRelay = (): void => {
    const groupsOfSession = async (sessionId: string): Promise<string[]> => {
      const ids: string[] = []
      for (const item of await store.listGroups()) {
        const group = await store.getGroup(item.id)
        if (group.roomSessionId === sessionId && sessionId !== '') continue
        if (group.members.some((member) => member.sessionId === sessionId)) ids.push(group.id)
      }
      return ids
    }
    const roomOfGroup = async (): Promise<string> => ''   // 群不再有会话
    const mirror = installMemberMirror({
      ctx,
      groupsOfSession,
      roomOfGroup,
      async record(sessionId, groupId, text, seq) {
        const group = await store.getGroup(groupId)
        const member = group.members.find((item) => item.sessionId === sessionId)
        if (member === undefined) return
        /**
         * 只镜像「正在回群里的活」的回复。
         *
         * 早先无条件镜像每个成员的每条 assistant 回复 —— 结果任何在群里的会话
         * （包括做开发/聊天的那种）写什么都会被广播进群，群里变成某个会话的
         * 独白，连"输出到上限"这种系统提示都被贴进去。
         * 现在要求：该成员名下有一条**未收口的任务**，才把回复当作群里的话。
         * 纯闲聊、开发过程、截断提示一律不进群。
         */
        const hasOpenTask = group.tasks.some(
          (task) => task.status === 'dispatched' && task.targets.includes(member.name),
        )
        // 有未收口任务 = 在回活；刚被群里 @ 过 = 在回话。两者都算「对群发言」。
        const wokenByGroup = wasRecentlyWoken(sessionId)
        if (!hasOpenTask && !wokenByGroup) return
        const name = member.name
        const role = member?.role === 'lead' ? 'lead' : member?.role === 'external' ? 'external' : 'member'
        await store.appendMessage(groupId, {
          from: name,
          role,
          kind: 'report',
          text,
          id: `member-${sessionId}-${seq}`,
        })
        const room = group.roomSessionId ?? ''
        if (room !== '') {
          const { postToRoom } = await import('./room.ts')
          await postToRoom({ ctx, logger: log }, room, `【${name}】${text}`)
        }
      },
      logger: log,
    })

    /**
     * 只装「成员回复进群」这一半。
     *
     * 输入方向不再靠会话中继：人在**面板**里说话就走 HTTP /say 分派给成员，
     * 不需要一个会话替人转达。这样群完全不经过模型轮次，
     * 也就不会出现「输出到 token 上限」之类的会话提示。
     */
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        mirror.dispose()
      }, 'pipeline-bot: mirror')
    }
    log.info('成员回复镜像已安装（群历史在插件存储，不经会话）')
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
    // inject 回调的返回值会被当作 disposer，跟着依赖作用域回收
    ctx.inject(['tools'], mountTools)
  } else {
    const dispose = mountTools()
    if (typeof ctx.effect === 'function') ctx.effect(dispose, 'pipeline-bot: tools')
  }

  installRelay()

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
