/**
 * 群总线：**以群为中心**的协作核心（不绑项目）。
 *
 * 一个 GroupBus 实例服务一个群。群成员可以来自任意项目、任意 DSH 会话、任意外部产品。
 *
 * 两条路径，都是真实的协作（不是转发）：
 *
 *   ① 谁在群里说话（人 / 组长 / 成员 / 外部产品）
 *        → 消息落群
 *        → 解析 @（没 @ 时按角色默认）
 *        → **同时唤醒所有被点到的成员**（steer；冷会话 followup+唤醒；外部产品进收件箱）
 *        → 每个成员用自己的上下文干活，并可以继续 @ 别人 —— 形成成员之间的任意边
 *
 *   ② 派活 / 回执
 *        → assign 登记 taskId，并行唤醒全部目标
 *        → report 挂到 taskId，唤醒派活人；全部交齐再叫醒发起者收尾
 *
 * 投递细节（如何真的把对方叫起来）见 deliver.ts；外部产品协议见 bridge.ts。
 */
import { inboxFor } from './bridge.ts'
import { deliver, isLive } from './deliver.ts'
import { collectNames, listCandidates, resolveMembers } from './discovery.ts'
import { syncName } from './names.ts'
import { resolveService } from './util.ts'
import { MIRROR_PREFIX } from './relay.ts'
import { ensureRoom, postToRoom } from './room.ts'
import {
  addMember,
  appendMessage,
  bindSession,
  boundSessionOf,
  clearRoomMirrorLedger,
  isRoomMirrored,
  markRoomMirrored,
  clearMessages,
  ensureMemberIds,
  findTask,
  getGroup,
  removeMember,
  setGroupProject,
  setRoom,
  upsertTask,
} from './store.ts'
import type { Candidate, Group, Member, Message, Task } from './types.ts'
import { asText, asTextList, memberIdOf, shortRandom } from './util.ts'

export interface BusDeps {
  ctx: any
  groupId: string
  logger?: { info?(message: string): void; warn?(message: string): void }
}

export function parseMentions(text: string, members: readonly Member[]): string[] {
  const hits: string[] = []
  const pattern = /[@＠]\s*([^\s@＠,，。;；:：、]+)/g
  const byName = new Map(members.map((member) => [normalizeName(member.name), member.name]))
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const resolved = byName.get(normalizeName(match[1]!.trim()))
    if (resolved !== undefined && !hits.includes(resolved)) hits.push(resolved)
  }
  return hits
}

export function normalizeName(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
}

export interface SpeakOptions {
  from: string
  role: 'human' | 'lead' | 'member' | 'external'
  text: string
  targets?: readonly string[]
  taskId?: string
  kind?: Message['kind']
  silent?: boolean
  mode?: 'steer' | 'followup' | 'notify'
  maxWakes?: number
  /** 成员回执时填派活人，只叫醒它（不惊动组长）。 */
  replyTo?: string
}

export interface DeliveryLine {
  name: string
  sessionId: string
  detail: string
  ok: boolean
  outcome: string
}

export interface SpeakResult {
  message: Message
  targets: string[]
  deliveries: DeliveryLine[]
  note: string
}

/**
 * 最近被群唤醒过的会话：sessionId → 时间戳。
 *
 * 用途：镜像门槛。除了「有未收口任务」，**刚被群里 @ 过**也算「在回群里的活」——
 * 否则「@ 某人一句话，他回一句」这种最基本用法，回复不会出现在群里。
 * 窗口取 10 分钟：够一轮对话，又不至于把之后的闲聊也广播出去。
 */
/**
 * 唤醒预算：同一个群在 60 秒内最多**唤醒** 3 个成员。
 *
 * 为什么必须有：成员发言会被写回群，若这条又能唤醒别人，就形成
 * 「A 发言 → 唤醒 B → B 发言 → 唤醒 C → …」的活锁。实测一次活锁让
 * `loop跑章` 15 分钟堆 169 条消息、几十个会话并发跑 turn，
 * 主线程被提示词组装占满，UI 直接卡死（host.hungFn ×415）。
 *
 * 超出预算不是丢消息：照常入队（`notify`，不唤醒），只是不把人叫起来。
 */
const wakeBudget = new Map<string, number[]>()
const WAKE_BUDGET_WINDOW_MS = 60_000
const WAKE_MAX_PER_WINDOW = 3

function takeWakeSlot(groupId: string): boolean {
  const now = Date.now()
  const kept = (wakeBudget.get(groupId) ?? []).filter((at) => now - at < WAKE_BUDGET_WINDOW_MS)
  if (kept.length >= WAKE_MAX_PER_WINDOW) {
    wakeBudget.set(groupId, kept)
    return false
  }
  kept.push(now)
  wakeBudget.set(groupId, kept)
  return true
}

const recentlyWoken = new Map<string, number>()
const WAKE_WINDOW_MS = 10 * 60 * 1000

/**
 * 判断一个名字是不是 `base` 的交接接班人，返回交接代次（1 = `<base>-handoff`）。
 *
 * 规则来自 `dsh-context-bridge`（src/bus-names.js）：
 *   第一次交接 `<源名>-handoff`，第二次 `<源名>-handoff-2`，依此类推。
 * 只做字符串比较、不拼正则 —— 名字里可能有 `.` `*` `(` 这类字符，
 * 用正则要转义，容易写错（这里就被写坏过一次）。
 */
export function handoffRank(name: string, base: string): number | undefined {
  const target = asText(name).trim().toLowerCase()
  const root = asText(base).trim().toLowerCase()
  if (target === '' || root === '') return undefined
  if (target === `${root}-handoff`) return 1
  const prefix = `${root}-handoff-`
  if (!target.startsWith(prefix)) return undefined
  const tail = target.slice(prefix.length)
  if (tail === '' || !/^[0-9]+$/.test(tail)) return undefined
  const rank = Number(tail)
  return rank >= 2 ? rank : undefined
}

export function markWoken(sessionId: string): void {
  if (sessionId === '') return
  recentlyWoken.set(sessionId, Date.now())
  if (recentlyWoken.size > 200) {
    for (const [id, at] of recentlyWoken) {
      if (Date.now() - at > WAKE_WINDOW_MS) recentlyWoken.delete(id)
    }
  }
}

export function wasRecentlyWoken(sessionId: string): boolean {
  const at = recentlyWoken.get(sessionId)
  if (at === undefined) return false
  if (Date.now() - at > WAKE_WINDOW_MS) {
    recentlyWoken.delete(sessionId)
    return false
  }
  return true
}

export class GroupBus {
  private deps: BusDeps

  constructor(deps: BusDeps) {
    this.deps = deps
  }

  reconfigure(patch: Partial<BusDeps>): void {
    this.deps = { ...this.deps, ...patch }
  }

  get groupId(): string {
    return this.deps.groupId
  }

  async group(): Promise<Group> {
    return getGroup(this.deps.groupId)
  }

  /** 候选池 + 成员（现算在线状态）。 */
  async members(): Promise<{ group: Group; members: Member[]; candidates: Candidate[] }> {
    await ensureMemberIds(this.deps.groupId)
    const group = await this.group()
    const names = await collectNames(this.deps.ctx)
    // 群里成员若在别的项目（未登记为 workspace）也要能读到名册
    for (const record of group.members) {
      if (record.sessionId === undefined) continue
      const candidate = names.get(record.sessionId)
      void candidate
    }
    const pool = await listCandidates(this.deps.ctx, {
      namesBySession: names,
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    })
    const externals: Member[] = group.members
      .filter((record) => record.role === 'external')
      .map((record) => ({
        name: record.name,
        sessionId: '',
        role: 'external' as const,
        status: 'inactive' as const,
        product: record.product ?? 'external',
      }))
    // 进程内绑定优先：文件可能被并发写冲掉，但绑定本身不该丢
    const withBindings: typeof group.members = []
    for (const record of group.members) {
      if (record.sessionId !== undefined && record.sessionId !== '') {
        withBindings.push(record)
        continue
      }
      const bound = boundSessionOf(group.id, record.name)
      if (bound !== undefined) {
        withBindings.push({ ...record, sessionId: bound })
        continue
      }
      // 还没绑定：按名字在候选池里找一次，找到就绑（并落盘），
      // 否则成员永远显示"无会话"、@ 也永远叫不醒。
      if (record.role === 'external') {
        withBindings.push(record)
        continue
      }
      const wanted = normalizeName(record.name)
      const guess =
        pool.candidates.find((item) => normalizeName(item.name) === wanted) ??
        pool.candidates.find((item) => normalizeName(item.id) === wanted)
      if (guess === undefined) {
        withBindings.push(record)
        continue
      }
      await bindSession(group.id, record.name, guess.sessionId)
      void syncName(
        this.deps.logger === undefined ? {} : { logger: this.deps.logger },
        guess.cwd ?? '',
        guess.sessionId,
        record.name,
      )
      withBindings.push({ ...record, sessionId: guess.sessionId })
    }
    // 结构性去重：同名成员只保留一条（历史上的重复记录不再显示成两个人）
    const seenNames = new Set<string>()
    const uniqueRecords = withBindings.filter((record) => {
      const key = normalizeName(record.name)
      if (key === '' || seenNames.has(key)) return false
      seenNames.add(key)
      return true
    })
    const members = resolveMembers(uniqueRecords, pool.candidates, externals)

    /**
     * 自动跟随上下文交接。
     *
     * `dsh-context-bridge` 交接时会建新会话并给它命名 `<源会话名>-handoff`、
     * 第二次 `<源会话名>-handoff-2`（见其 src/bus-names.js 的 SUFFIX）。
     * 那个名字会写进 `.dsh-bus/names.json`，也就是这里的候选名。
     *
     * 于是「成员绑定的会话被交接掉」这件事是可识别的：只要候选池里出现
     * `<该成员当前会话名>-handoff[-N]`，它就是接班人 —— 自动改绑，
     * 不需要人再去手动点。找不到就保持原样，绝不动已有绑定。
     */
    await this.adoptHandoffs(group, members, pool.candidates)
    // 在线状态以「此刻活着没有」为准
    for (const member of members) {
      if (member.role === 'external' || member.sessionId === '') continue
      member.status = isLive(this.deps.ctx, member.sessionId) ? 'live' : 'inactive'
    }
    // 幂等回填：老成员也要进总线名册，否则「群里叫什么、总线搜不到什么」
    for (const member of members) {
      if (member.sessionId === '' || member.cwd === undefined) continue
      await syncName(
        this.deps.logger === undefined ? {} : { logger: this.deps.logger },
        member.cwd,
        member.sessionId,
        member.name,
      )
    }
    const addedIds = new Set(members.map((member) => member.sessionId).filter((id) => id !== ''))
    // 只按 sessionId 判"已加入"：按名字判会把「同名但不同会话」误标成已加入，
    // 面板上看起来像"同一个人出现两次"。
    const candidates = pool.candidates.map((candidate) => ({
      ...candidate,
      added: addedIds.has(candidate.sessionId),
    }))
    return { group, members, candidates }
  }

  /**
   * 解析一个投递目标；**不在群里但宿主里能找到**时自动认领入群。
   *
   * 为什么需要：组长看到的是会话标题（「创建一个带左侧栏入口的 DSH」），
   * 它未必已经在成员列表里 —— 早先会直接报「群里没有这些成员」，
   * 于是组长退回 dsh_bus_send，又撞上另一套名册（目标不存在）。
   * 现在按 名字 / 成员 id / 会话标题 / session id 依次匹配候选池，
   * 命中就加入群并写一条可核对的系统消息，然后正常投递。
   */
  private async adoptTarget(
    members: Member[],
    candidates: readonly Candidate[],
    ref: string,
  ): Promise<Member | undefined> {
    const found = this.resolveMember(members, ref)
    // 成员记录存在但**没绑会话**（例如迁移来的组长）：按名字在候选池里补绑，
    // 否则 @ 它永远不会醒，而工具还报「已投递/无绑定」看不出问题。
    if (found !== undefined && found.sessionId === '' && found.role !== 'external') {
      const wanted = normalizeName(found.name)
      const match =
        candidates.find((item) => normalizeName(item.name) === wanted) ??
        candidates.find((item) => normalizeName(item.id) === wanted) ??
        candidates.find((item) => normalizeName(item.name).includes(wanted))
      if (match !== undefined) {
        await bindSession(this.deps.groupId, found.name, match.sessionId)
        void syncName(
          this.deps.logger === undefined ? {} : { logger: this.deps.logger },
          match.cwd ?? '',
          match.sessionId,
          found.name,
        )
        const refreshed = await this.members()
        const rebound = this.resolveMember(refreshed.members, found.name)
        if (rebound !== undefined) return rebound
      }
      return found
    }
    if (found !== undefined) return found
    const raw = asText(ref).trim()
    if (raw === '') return undefined
    const wanted = normalizeName(raw)
    const candidate =
      candidates.find((item) => item.sessionId === raw) ??
      candidates.find((item) => normalizeName(item.name) === wanted) ??
      candidates.find((item) => normalizeName(item.id) === wanted) ??
      candidates.find((item) => normalizeName(item.name).includes(wanted))
    if (candidate === undefined) return undefined
    const group = await addMember(this.deps.groupId, {
      name: candidate.name,
      sessionId: candidate.sessionId,
      id: candidate.id,
    })
    void syncName(
      this.deps.logger === undefined ? {} : { logger: this.deps.logger },
      candidate.cwd ?? '',
      candidate.sessionId,
      candidate.name,
    )
    const member = await this.members()
    void group
    return this.resolveMember(member.members, candidate.name)
  }

  /** @名字 / 成员 id / session id 都能寻址（模型常把 id 当名字用）。 */
  resolveMember(members: readonly Member[], ref: string): Member | undefined {
    const raw = asText(ref).trim()
    if (raw === '') return undefined
    const wanted = normalizeName(raw)
    const wantedId = memberIdOf(raw)
    return (
      members.find((member) => normalizeName(member.name) === wanted) ??
      members.find((member) => normalizeName(member.id ?? '') === wanted) ??
      members.find((member) => (member.id ?? '') === wantedId) ??
      members.find((member) => member.sessionId === raw) ??
      members.find((member) => normalizeName(member.name).startsWith(wanted))
    )
  }

  /**
   * 群聊会话：落在**已存在的项目**里（群的 projectRoot，或调用方项目），
   * 并固定在会话列表第一位。群与成员的关系记在群元数据里。
   */
  /** 兼容旧调用：群不再有会话。 */
  async ensureRoomSession(preferredProject?: string): Promise<string> {
    void preferredProject
    return ''
  }

  private async ensureRoomSessionLegacy(preferredProject?: string): Promise<string> {
    const group = await this.group()
    const room = await ensureRoom(
      { ctx: this.deps.ctx, ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }) },
      group,
      preferredProject,
    )
    if (room.sessionId === '') return ''
    if (room.sessionId !== group.roomSessionId || room.projectRoot !== group.projectRoot) {
      await setRoom(group.id, room.sessionId)
      if (room.projectRoot !== '') await setGroupProject(group.id, room.projectRoot)
    }
    return room.sessionId
  }

  /**
   * 把一条群消息写进群聊会话。
   *
   * 两条克制：
   *   ① **按 id 去重**：写过的消息 id 记进 `roomMirrored`，回填/重放不会重复写
   *   ② **只写有信息量的**：wake（"→ 某人：已唤醒"）这类高频噪音不写 ——
   *      每写一条都要过一次群会话的请求，而它的上下文会越来越长，成本随之上升
   */
  /**
   * 群消息**不写入任何会话**。
   *
   * 参考实现（MJ-CJM/DSH-Bot、omdsh-dev/dsh-bot）把群历史放在插件自己的
   * storage domain，由插件自己的 Client 组件渲染；会话只用于成员各自的上下文。
   *
   * 我早先把群写成「一个真会话」，代价是：每条群消息都要过一轮模型请求，
   * 而为了不让它冒充发言人我把 maxTokens 压到 1 —— 结果每轮都以 max-tokens 结束，
   * DSH 的 UI 就显示出「已达到输出 token 上限…发送继续」，看起来像群坏了。
   * 现在群只存在于插件（存储 + 面板），彻底不碰会话轮次。
   */
  private async mirrorToRoom(message: Message): Promise<void> {
    try {
      void message
      return
      const group = await this.group()
      const roomId = group.roomSessionId ?? ''
      if (roomId === '') return
      if (await isRoomMirrored(group.id, message.id)) return
      const result = await postToRoom(
        { ctx: this.deps.ctx, ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }) },
        roomId,
        `${MIRROR_PREFIX}${message.from}：${asText(message.text).split(MIRROR_PREFIX).join('').trim()}`,
      )
      if (result.ok && result.duplicate !== true) await markRoomMirrored(group.id, message.id)
    } catch {
      /* 镜像失败不影响群本身 */
    }
  }

  /** 在群里说话 —— 唯一的公共通道。所有唤醒都从这里出去。 */
  async speak(options: SpeakOptions): Promise<SpeakResult> {
    const text = asText(options.text).trim()
    if (text === '') throw new Error('消息为空')
    const group = await this.group()
    const { members, candidates } = await this.members()
    const me = this.resolveMember(members, options.from)

    /**
     * 唤醒闸门：只有「人手动发言」和「任务派发」可以唤醒成员。
     *
     * 早先成员回复也解析 @ 并唤醒（还会默认叫醒派活人），于是
     * 「发言 → 写回群 → 再唤醒」闭环成活锁，把 UI 拖死。
     * 现在：report / system / wake 一律**不解析 @、不唤醒**，只记录。
     * 群被静音（group.muted）时，连人和派活也不唤醒。
     */
    const muted = (group as { muted?: boolean }).muted === true
    /**
     * 谁会唤醒谁 —— 三道闸：
     *   ① 群静音（group.muted）时谁都不唤醒，只入群
     *   ② 人类发言、派活（kind = "assign"）一定可以唤醒
     *   ③ 成员之间的普通发言也可以唤醒 —— 多 agent 在群里互相唤醒干活是这套东西的
     *      目的；一律禁掉就退化成「只有人能叫人」的转发器。
     *      但回执（kind = "report"）永远不唤醒：回执负责收口任务、由派活方下一轮读，
     *      若回执也互相唤醒，成员之间会互相叫醒形成活锁（2026-11-19 事故）。
     * 唤醒次数另受 takeWakeSlot（每群 10 分钟 3 次）与 recentlyWoken 窗口限制。
     */
    const wakeAllowed =
      !muted &&
      (options.role === 'human' ||
        options.kind === 'assign' ||
        ((options.role === 'member' || options.role === 'external') && options.kind !== 'report'))
    const mentioned = wakeAllowed ? parseMentions(text, members) : []
    const explicit = wakeAllowed
      ? asTextList(options.targets).map((name) => this.resolveMember(members, name)?.name ?? name)
      : []

    const wanted: string[] = []
    // 认领会改变成员集合，所以把解析结果按名字存下来给投递阶段用 ——
    // 否则投递时拿旧 members 再 resolve 一次会得到 undefined（实测崩在 member.role）。
    const resolved = new Map<string, Member>()
    for (const name of [...explicit, ...mentioned]) {
      const member = await this.adoptTarget(members, candidates, name)
      if (member === undefined) continue
      if (member.sessionId !== '' && me?.sessionId === member.sessionId) continue
      if (member.name === me?.name) continue
      resolved.set(member.name, member)
      if (!wanted.includes(member.name)) wanted.push(member.name)
    }

    const lead = members.find((member) => member.role === 'lead')
    if (wakeAllowed && wanted.length === 0 && options.silent !== true) {
      if (options.role === 'human') {
        if (lead !== undefined) wanted.push(lead.name)
      } else if (options.role === 'member' || options.role === 'external') {
        const initiator =
          options.replyTo === undefined
            ? undefined
            : members.find((member) => normalizeName(member.name) === normalizeName(options.replyTo!))
        if (initiator !== undefined && okTarget(initiator, me)) wanted.push(initiator.name)
        else if (options.replyTo === undefined && lead !== undefined && okTarget(lead, me)) wanted.push(lead.name)
      }
    }

    const capped = wanted.slice(0, Math.max(1, options.maxWakes ?? 8))
    const appended = await appendMessage(group.id, {
      from: asText(options.from) || 'system',
      ...(me === undefined ? {} : { fromId: me.id }),
      role: options.role,
      kind: options.kind ?? (options.role === 'human' ? 'human' : 'report'),
      text,
      ...(capped.length === 0 ? {} : { targets: capped }),
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    })
    void this.mirrorToRoom(appended.message)

    const deliveries: DeliveryLine[] = []
    for (const name of capped) {
      const member = resolved.get(name) ?? this.resolveMember(members, name)
      if (member === undefined) continue
      if (member.role === 'external') {
        deliveries.push({
          name: member.name,
          sessionId: '',
          detail: `已投递到 ${member.product ?? '外部产品'} 收件箱（它下次 poll 取走）`,
          ok: true,
          outcome: 'queued',
        })
        continue
      }
      if (member.sessionId === '') {
        // 没绑定会话 = 叫不醒。必须**如实报失败**：
        // 早先这里静默跳过，结果 assign 把任务标成 dispatched、发起人以为派成功了，
        // 实际没有一个人被唤醒（用户看到的就是「派了但没人回」）。
        deliveries.push({
          name: member.name,
          sessionId: '',
          detail: '未绑定会话（先在面板或用 pipeline_bind 绑定）',
          ok: false,
          outcome: 'unbound',
        })
        continue
      }
      const body = this.composeWake({ options, member, members, text, group, taskId: options.taskId })
      // 预算用尽 → 降级为「只入队不唤醒」，不丢消息，只是不再把人叫起来
      const granted = wakeAllowed && takeWakeSlot(group.id)
      const mode = granted ? (options.mode ?? 'steer') : 'notify'
      const result = await deliver(
        { ctx: this.deps.ctx, ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }) },
        member.sessionId,
        body,
        mode,
        { id: options.role === 'human' ? 'human' : 'pipeline-bot', name: options.from },
      )
      if (result.ok && granted) markWoken(member.sessionId)
      const detail = granted
        ? result.detail
        : muted
          ? `群已静音：已入队未唤醒（${result.detail}）`
          : `唤醒预算用尽（60s/${WAKE_MAX_PER_WINDOW}）：已入队未唤醒（${result.detail}）`
      deliveries.push({ name: member.name, sessionId: member.sessionId, detail, ok: result.ok, outcome: granted ? result.outcome : 'queued' })
    }

    if (deliveries.length > 0) {
      await appendMessage(group.id, {
        from: 'system',
        role: 'system',
        kind: 'wake',
        text: deliveries.map((item) => `→ ${item.name}：${item.ok ? item.detail : `未投递（${item.detail}）`}`).join('\n'),
        ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      })
    }

    const note =
      muted
        ? '群已静音：消息只入群，不唤醒任何人。要恢复唤醒，在群面板点「已静音」开关。'
        : deliveries.length > 0 && deliveries.every((item) => !item.ok)
        ? '一个都没唤醒成功，看下面每条的原因。'
        : capped.length === 0 && options.silent !== true
          ? '这条消息没有唤醒任何人（可以 @成员 或指派任务）。'
          : ''

    return { message: appended.message, targets: capped, deliveries, note }
  }

  private composeWake(input: {
    options: SpeakOptions
    member: Member
    members: readonly Member[]
    text: string
    group: Group
    taskId?: string
  }): string {
    const { options, member, members, text, group, taskId } = input
    const roster = members
      .filter((item) => item.name !== member.name)
      .map((item) => {
        const state = item.role === 'external' ? `外部·${item.product ?? ''}` : item.status === 'live' ? '醒着' : '离线'
        return `${item.name}(${state}${item.duty === undefined ? '' : `·${item.duty}`})`
      })
      .slice(0, 24)
      .join('、')
    return [
      `【群 ${group.title}】${options.from} 在群里说：`,
      '',
      text,
      '',
      `你在这个群里的身份：${member.name}${member.role === 'lead' ? '（组长）' : ''}。`,
      `群成员：${roster === '' ? '（暂无其他成员）' : roster}。`,
      '',
      '【必须遵守的协作方式】',
      '· 群里的协作**只用** `pipeline_say` / `pipeline_assign` / `pipeline_report`。',
      '· **不要用 `dsh_bus_send` 给群成员发消息** —— 那是私信，不会出现在群里，',
      '  其他成员看不到上下文，人也不知道你们在干什么。',
      '· 要跟谁说话，就 `pipeline_say` 并在正文里 @ 他；他会醒，回复会回到群里。',
      '',
      '你在群里能做的事（都是公共群聊，不是私聊）：',
      '· `pipeline_say` —— 发言；@ 到谁就同时唤醒谁',
      '· `pipeline_assign` —— 派活（targets 可多个，一次并行叫醒）',
      `· \`pipeline_report\` —— 交回执${taskId === undefined ? '' : `（taskId=${taskId}）`}`,
      '· `pipeline_members` —— 看成员、在线状态、以及可加入的候选会话',
      '',
      member.role === 'lead'
        ? '你是组长：判断该谁做、怎么拆；派完一句话说清分工即可。'
        : '做完就回执；需要别人配合直接 @ 他，不用等组长转。',
      '不要臆造名单外的人；不要重复派同一件事（先看群消息里已有的任务号）。',
    ].join('\n')
  }

  /** 派活：= 发言 + 登记任务 + 唤醒全部目标。 */
  async assign(
    brief: string,
    targetNames: readonly string[],
    options: { from?: string; taskId?: string } = {},
  ): Promise<{ task: Task; message: Message; deliveries: DeliveryLine[] }> {
    const text = asText(brief).trim()
    if (text === '') throw new Error('派活内容为空')
    const names = asTextList(targetNames)
    if (names.length === 0) throw new Error('没指定派给谁')

    const group = await this.group()
    const { members, candidates } = await this.members()
    const resolved: Member[] = []
    const unknown: string[] = []
    for (const name of names) {
      const member = await this.adoptTarget(members, candidates, name)
      if (member === undefined) unknown.push(name)
      else if (!resolved.some((item) => item.name === member.name)) resolved.push(member)
    }
    if (unknown.length > 0) {
      const hint = candidates
        .filter((item) => !item.added)
        .slice(0, 8)
        .map((item) => item.name)
        .join('、')
      throw new Error(
        `找不到这些成员：${unknown.join('、')}。群里也没有同样名字的会话` +
          (hint === '' ? '（宿主里没有可加入的候选会话）' : `；可加入的还有：${hint}`) +
          '。用 pipeline_members 看完整名单。',
      )
    }

    const author = options.from ?? group.leadName
    const now = Date.now()
    const task: Task = {
      id: options.taskId ?? shortRandom('task'),
      createdAt: now,
      updatedAt: now,
      brief: text,
      from: author,
      targets: resolved.map((member) => member.name),
      status: 'dispatched',
      deliveries: {},
    }

    const spoken = await this.speak({
      from: author,
      role: normalizeName(author) === normalizeName(group.leadName) ? 'lead' : 'member',
      kind: 'assign',
      text: `@${task.targets.join(' @')} ${text}`,
      targets: task.targets,
      taskId: task.id,
    })
    for (const item of spoken.deliveries) {
      task.deliveries[item.name] = item.ok ? `${item.outcome}：${item.detail}` : `失败：${item.detail}`
    }
    const failed = Object.values(task.deliveries).filter((detail) => detail.startsWith('失败'))
    task.status = failed.length === resolved.length ? 'failed' : 'dispatched'
    await upsertTask(group.id, task)
    return { task, message: spoken.message, deliveries: spoken.deliveries }
  }

  /** 回执：挂任务 + 唤醒派活人；交齐再叫醒发起者收尾。 */
  async report(
    reportText: string,
    options: { from: string; taskId?: string; silent?: boolean },
  ): Promise<{ task?: Task; message: Message; woke: string[] }> {
    const text = asText(reportText).trim()
    if (text === '') throw new Error('回执内容为空')
    const group = await this.group()
    const author = asText(options.from).trim() || '成员'
    const task = await findTask(group.id, options.taskId)

    const spoken = await this.speak({
      from: author,
      role: normalizeName(author) === normalizeName(group.leadName) ? 'lead' : 'member',
      kind: 'report',
      text,
      ...(task === undefined ? {} : { taskId: task.id, replyTo: task.from }),
      silent: options.silent === true,
    })
    if (task === undefined) return { message: spoken.message, woke: spoken.targets }

    const reports = { ...(task.reports ?? {}), [author]: text }
    const allReported = task.targets.every((name) => reports[name] !== undefined)
    const next: Task = {
      ...task,
      status: allReported ? 'reported' : 'dispatched',
      reports,
      report: allReported
        ? Object.entries(reports).map(([who, what]) => `${who}：${what}`).join('\n\n')
        : task.report,
      updatedAt: Date.now(),
    }
    await upsertTask(group.id, next)

    if (!allReported) return { task: next, message: spoken.message, woke: spoken.targets }

    // 回执齐了：把汇总送进群；发起者若已在本次回执里被唤醒过，就只补记录不再唤醒
    // （曾经无条件再叫一次 → 同一个人被唤醒两遍，纯噪音且会重复跑一轮）
    const alreadyWokeInitiator = spoken.targets.includes(task.from)
    const woke: string[] = alreadyWokeInitiator ? [...spoken.targets] : []
    if (task.from !== author) {
      const extra = await this.speak({
        from: 'system',
        role: 'lead',
        kind: 'system',
        text:
          `任务 ${task.id} 的回执齐了：\n\n` +
          Object.entries(reports).map(([who, what]) => `【${who}】${what}`).join('\n\n') +
          `\n\n（${task.from}：收尾给一句结论，或继续加派 —— 派活用 pipeline_assign）`,
        targets: alreadyWokeInitiator ? [] : [task.from],
        ...(alreadyWokeInitiator ? { silent: true } : {}),
        taskId: task.id,
      } as any)
      if (!alreadyWokeInitiator) woke.push(...extra.targets)
    }
    return { task: next, message: spoken.message, woke }
  }

  async say(text: string, from?: string, silent = false): Promise<SpeakResult> {
    const group = await this.group()
    const author = from ?? group.leadName
    const role = normalizeName(author) === normalizeName(group.leadName) ? 'lead' : 'member'
    return this.speak({ from: author, role, kind: 'report', text: asText(text).trim(), silent })
  }

  /** 外部产品拉取发给自己的消息。 */
  async inboxForExternal(memberName: string, options: { ambient?: boolean } = {}): Promise<{
    items: ReturnType<typeof inboxFor>
    cursor: number
  }> {
    const group = await this.group()
    const record = group.members.find((item) => normalizeName(item.name) === normalizeName(memberName))
    const cursor = 0
    const items = inboxFor(group.messages, memberName, cursor, { ambient: options.ambient === true })
    void record
    return { items, cursor }
  }

  /**
   * 重建群聊会话：新会话干净、旧会话归档。
   *
   * 用途：历史里已经存在的重复记录（同一条写过 6 次那批）是**不可变日志**，
   * 删不掉。与其让用户对着一条脏记录看，不如换一个干净的会话，
   * 只把「有信息量的最近 N 条」重新写进去，然后把旧的归档。
   */
  async rebuildRoom(limit = 24): Promise<{ sessionId: string; wrote: number; archived: string; detail: string }> {
    const group = await this.group()
    const old = group.roomSessionId ?? ''
    // 新会话要重新写一遍，所以先清该群的镜像账本
    await clearRoomMirrorLedger(group.id)
    const room = await ensureRoom(
      { ctx: this.deps.ctx, ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }) },
      { ...group, roomSessionId: undefined },
      group.projectRoot,
      true,
    )
    if (room.sessionId === '') return { sessionId: '', wrote: 0, archived: '', detail: room.detail }
    await setRoom(group.id, room.sessionId)
    const filled = await this.backfillRoom(limit)
    let archived = ''
    if (old !== '' && old !== room.sessionId) {
      const registry = resolveService<any>(this.deps.ctx, 'workspaceRegistry')
      try {
        await registry?.archiveSession?.(old, { stopActivity: true })
        archived = old
      } catch {
        /* 归档失败不影响新会话 */
      }
    }
    return {
      sessionId: room.sessionId,
      wrote: filled.wrote,
      archived,
      detail: `${room.detail}；${filled.detail}${archived === '' ? '' : '；旧会话已归档'}`,
    }
  }

  /**
   * 把群历史补写进群聊会话（幂等由调用方按时间点控制）。
   * 用于修复「以前用 inject 镜像，导致会话里看不到群消息」的历史数据。
   */
  async backfillRoom(limit = 30): Promise<{ wrote: number; detail: string }> {
    const group = await this.group()
    const room = group.roomSessionId ?? ''
    if (room === '') return { wrote: 0, detail: '没有群聊会话' }
    // 只补写「当前仍是群成员」的发言与人的发言：
    // 早先会把已移出成员的旧闲聊（例如做开发的那个会话）也补进新会话，
    // 结果新会话里全是无关内容。
    const memberNames = new Set(group.members.map((member) => normalizeName(member.name)))
    const recent = group.messages
      .filter((message) => message.kind !== 'wake')
      .filter((message) => {
        if (message.role === 'human' || message.role === 'system') return true
        return memberNames.has(normalizeName(message.from))
      })
      .slice(-limit)
    let wrote = 0
    let skipped = 0
    for (const message of recent) {
      if (await isRoomMirrored(group.id, message.id)) {
        skipped += 1
        continue
      }
      const result = await postToRoom(
        { ctx: this.deps.ctx, ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }) },
        room,
        `${MIRROR_PREFIX}${message.from}：${asText(message.text).split(MIRROR_PREFIX).join('').trim()}`,
      )
      if (result.ok && result.duplicate !== true) {
        await markRoomMirrored(group.id, message.id)
        wrote += 1
      } else if (result.duplicate === true) {
        await markRoomMirrored(group.id, message.id)
        skipped += 1
      }
    }
    return { wrote, detail: `补写 ${wrote} 条，已存在跳过 ${skipped} 条（共 ${recent.length} 条）` }
  }

  async addMember(member: {
    name: string
    sessionId?: string
    duty?: string
    product?: string
    id?: string
    glyph?: string
    image?: string
  }): Promise<Group & { detail?: string }> {
    const before = await this.group()
    const existed = before.members.some(
      (item) => normalizeName(item.name) === normalizeName(member.name),
    )
    const group = await addMember(this.deps.groupId, member)
    const after = group.members.find((item) => normalizeName(item.name) === normalizeName(member.name))
    const beforeSid = before.members.find(
      (item) => normalizeName(item.name) === normalizeName(member.name),
    )?.sessionId ?? ''
    const afterSid = after?.sessionId ?? ''
    const detail = !existed
      ? `已把「${after?.name ?? member.name}」加入群`
      : beforeSid === afterSid
        ? `「${after?.name ?? member.name}」已经在群里了（无变化）`
        : `「${after?.name ?? member.name}」已改绑到 ${afterSid}`
    ;(group as any).detail = detail
    // 同步到会话总线名册：让 dsh_bus_* 也能用群里的同一个名字寻址
    const sessionId = asText(member.sessionId).trim()
    if (sessionId !== '') {
      const { members } = await this.members()
      const target = members.find((item) => item.sessionId === sessionId)
      if (target?.cwd !== undefined) {
        await syncName(
          this.deps.logger === undefined ? {} : { logger: this.deps.logger },
          target.cwd,
          sessionId,
          target.name,
        )
      }
    }
    return group
  }

  /**
   * 把群成员绑定到某个会话（按候选名 / 成员 id / session id 解析）。
   *
   * 用途：群成员常是「人起的名字」（跑章选手、门禁），而宿主里的会话叫
   * chapter / gate —— 名字对不上就永远叫不醒。绑定一次即可。
   */
  /**
   * 把「交接出来的新会话」自动接回对应成员。
   *
   * 判定链：成员 → 当前会话的**总线名**（候选里同 sessionId 的那条的名字）
   *        → 候选里 `<总线名>-handoff` / `<总线名>-handoff-N` 中序号最大的一条
   * 只在新会话确实不同于当前绑定时改绑；同一轮里一个会话只会接一个成员。
   */
  private async adoptHandoffs(
    group: { id: string },
    members: Member[],
    candidates: readonly Candidate[],
  ): Promise<void> {
    const nameOfSession = new Map<string, string>()
    for (const candidate of candidates) {
      if (candidate.sessionId !== '' && !nameOfSession.has(candidate.sessionId)) {
        nameOfSession.set(candidate.sessionId, normalizeName(candidate.name))
      }
    }

    // 先把「所有成员当前已占用的会话」记进 claimed：
    // 否则某个交接候选可能被另一个成员抢走，最后两个成员指向同一个会话。
    const claimed = new Set<string>()
    for (const member of members) {
      if (member.sessionId !== '') claimed.add(member.sessionId)
    }
    for (const member of members) {
      if (member.role === 'external') continue
      const base = nameOfSession.get(member.sessionId)
      if (base === undefined || base === '') continue
      let best: { sessionId: string; rank: number; at: number } | undefined
      for (const candidate of candidates) {
        if (candidate.sessionId === '') continue
        if (candidate.sessionId === member.sessionId) continue
        if (claimed.has(candidate.sessionId)) continue
        const rank = handoffRank(candidate.name, base)
        if (rank === undefined) continue
        const at = candidate.updatedAt ?? 0
        if (best === undefined || rank > best.rank || (rank === best.rank && at > best.at)) {
          best = { sessionId: candidate.sessionId, rank, at }
        }
      }
      if (best === undefined) continue
      claimed.delete(member.sessionId)
      claimed.add(best.sessionId)
      await bindSession(group.id, member.name, best.sessionId)
      member.sessionId = best.sessionId
      this.deps.logger?.info?.(
        `[dsh-pipeline-bot] 交接自动跟随：${member.name} → ${best.sessionId}（${base}-handoff${best.rank > 1 ? '-' + best.rank : ''}）`,
      )
    }
  }

  async bindMember(memberName: string, to: string): Promise<{ member: Member; candidates: string[] }> {
    const group = await this.group()
    const { members, candidates } = await this.members()
    const target = this.resolveMember(members, memberName)
    if (target === undefined) throw new Error(`群里没有这个成员：${memberName}`)
    const ref = asText(to).trim()
    const wanted = normalizeName(ref)
    const candidate =
      candidates.find((item) => item.sessionId === ref) ??
      candidates.find((item) => normalizeName(item.name) === wanted) ??
      candidates.find((item) => normalizeName(item.name).includes(wanted))
    if (candidate === undefined) {
      throw new Error(
        `找不到会话「${ref}」。可绑定的候选：${candidates
          .slice(0, 12)
          .map((item) => item.name)
          .join('、')}`,
      )
    }
    await bindSession(group.id, target.name, candidate.sessionId)
    void syncName(
      this.deps.logger === undefined ? {} : { logger: this.deps.logger },
      candidate.cwd ?? '',
      candidate.sessionId,
      target.name,
    )
    const refreshed = await this.members()
    return {
      member: this.resolveMember(refreshed.members, target.name) ?? target,
      candidates: refreshed.candidates.slice(0, 12).map((item) => item.name),
    }
  }

  async removeMember(ref: string): Promise<Group> {
    return removeMember(this.deps.groupId, ref)
  }

  async clear(): Promise<Group> {
    return clearMessages(this.deps.groupId)
  }

  async snapshot(preferredProject?: string): Promise<{
    group: Group
    members: Member[]
    candidates: Candidate[]
    roomSessionId: string
    bridgeKey: string
  }> {
    const roomSessionId = await this.ensureRoomSession(preferredProject)
    const { group, members, candidates } = await this.members()
    return { group, members, candidates, roomSessionId, bridgeKey: group.bridgeKey }
  }
}

function okTarget(member: Member, me: Member | undefined): boolean {
  if (me === undefined) return true
  if (member.sessionId !== '' && member.sessionId === me.sessionId) return false
  return member.name !== me.name
}
