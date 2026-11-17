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
import { ensureRoom, postToRoom } from './room.ts'
import {
  addMember,
  appendMessage,
  clearMessages,
  findTask,
  getGroup,
  removeMember,
  setGroupProject,
  setRoom,
  upsertTask,
} from './store.ts'
import type { Candidate, Group, Member, Message, Task } from './types.ts'
import { shortRandom } from './util.ts'

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
    const members = resolveMembers(group.members, pool.candidates, externals)
    // 在线状态以「此刻活着没有」为准
    for (const member of members) {
      if (member.role === 'external' || member.sessionId === '') continue
      member.status = isLive(this.deps.ctx, member.sessionId) ? 'live' : 'inactive'
    }
    const addedIds = new Set(members.map((member) => member.sessionId).filter((id) => id !== ''))
    const addedNames = new Set(members.map((member) => normalizeName(member.name)))
    const candidates = pool.candidates.map((candidate) => ({
      ...candidate,
      added: addedIds.has(candidate.sessionId) || addedNames.has(normalizeName(candidate.name)),
    }))
    return { group, members, candidates }
  }

  resolveMember(members: readonly Member[], ref: string): Member | undefined {
    const wanted = normalizeName(ref)
    if (wanted === '') return undefined
    return (
      members.find((member) => normalizeName(member.name) === wanted) ??
      members.find((member) => member.sessionId === ref) ??
      members.find((member) => normalizeName(member.name).startsWith(wanted))
    )
  }

  /**
   * 群聊会话：落在**已存在的项目**里（群的 projectRoot，或调用方项目），
   * 并固定在会话列表第一位。群与成员的关系记在群元数据里。
   */
  async ensureRoomSession(preferredProject?: string): Promise<string> {
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

  private async mirrorToRoom(message: Message): Promise<void> {
    try {
      const group = await this.group()
      const roomId = group.roomSessionId ?? ''
      if (roomId === '') return   // 没有群聊会话就只记群记录，不在发言路径上建会话
      await postToRoom(
        { ctx: this.deps.ctx, ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }) },
        roomId,
        `【群 ${group.title}】${message.from}：${message.text}`,
      )
    } catch {
      /* 镜像失败不影响群本身 */
    }
  }

  /** 在群里说话 —— 唯一的公共通道。所有唤醒都从这里出去。 */
  async speak(options: SpeakOptions): Promise<SpeakResult> {
    const text = String(options.text ?? '').trim()
    if (text === '') throw new Error('消息为空')
    const group = await this.group()
    const { members } = await this.members()
    const me = this.resolveMember(members, options.from)
    const mentioned = parseMentions(text, members)
    const explicit = (options.targets ?? []).map((name) => this.resolveMember(members, name)?.name ?? name)

    const wanted: string[] = []
    for (const name of [...explicit, ...mentioned]) {
      const member = this.resolveMember(members, name)
      if (member === undefined) continue
      if (member.sessionId !== '' && me?.sessionId === member.sessionId) continue
      if (member.name === me?.name) continue
      if (!wanted.includes(member.name)) wanted.push(member.name)
    }

    const lead = members.find((member) => member.role === 'lead')
    if (wanted.length === 0 && options.silent !== true) {
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
      from: options.from,
      role: options.role,
      kind: options.kind ?? (options.role === 'human' ? 'human' : 'report'),
      text,
      ...(capped.length === 0 ? {} : { targets: capped }),
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    })
    void this.mirrorToRoom(appended.message)

    const deliveries: DeliveryLine[] = []
    for (const name of capped) {
      const member = this.resolveMember(members, name)!
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
        // 没有绑定会话的成员（例如只在元数据里占位的组长）不投递、也不刷一条失败提示：
        // 每条消息都提醒一次「未投递」纯噪音，人看一眼成员列表就知道它离线。
        continue
      }
      const body = this.composeWake({ options, member, members, text, group, taskId: options.taskId })
      const result = await deliver(
        { ctx: this.deps.ctx, ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }) },
        member.sessionId,
        body,
        options.mode ?? 'steer',
        { id: options.role === 'human' ? 'human' : 'pipeline-bot', name: options.from },
      )
      deliveries.push({ name: member.name, sessionId: member.sessionId, detail: result.detail, ok: result.ok, outcome: result.outcome })
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
      deliveries.length > 0 && deliveries.every((item) => !item.ok)
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
    const text = String(brief ?? '').trim()
    if (text === '') throw new Error('派活内容为空')
    const names = targetNames.map((name) => String(name ?? '').trim()).filter((name) => name !== '')
    if (names.length === 0) throw new Error('没指定派给谁')

    const group = await this.group()
    const { members } = await this.members()
    const resolved: Member[] = []
    const unknown: string[] = []
    for (const name of names) {
      const member = this.resolveMember(members, name)
      if (member === undefined) unknown.push(name)
      else if (!resolved.some((item) => item.name === member.name)) resolved.push(member)
    }
    if (unknown.length > 0) throw new Error(`群里没有这些成员：${unknown.join('、')}。先 pipeline_members 看名单。`)

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
    const text = String(reportText ?? '').trim()
    if (text === '') throw new Error('回执内容为空')
    const group = await this.group()
    const author = String(options.from ?? '').trim() || '成员'
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
    return this.speak({ from: author, role, kind: 'report', text: String(text ?? '').trim(), silent })
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

  async addMember(member: { name: string; sessionId?: string; duty?: string; product?: string }): Promise<Group> {
    return addMember(this.deps.groupId, member)
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
