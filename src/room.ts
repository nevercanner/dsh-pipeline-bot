/**
 * 群聊会话：宿主会话体系里的一个**普通真实会话**。
 *
 * ── 设计判据（这是被纠正过的地方，写下来免得走回去）──────────────
 * 群不是项目。给群单独建一个目录再注册成 workspace，等于造一个假项目冒充容器 ——
 * 那会让侧栏多出一个不是项目的"项目"，还要用户维护它的目录。
 *
 * 正确做法：
 *   · 群聊会话落在**宿主里已存在的一个项目**（群的 `projectRoot`）里
 *   · 用宿主 `pinSession` 把它固定在会话列表第一位
 *   · 群与会话的关系、群与成员的关系都记在**群的元数据**里（groups.json）
 *   · 绝不为群创建目录或工作区；目标项目不存在就直接报错，不悄悄造一个
 *
 * 会话的 cwd 由它所属项目决定 —— 群不需要一个自己的目录。
 */
import type { Group } from './types.ts'
import { resolveService } from './util.ts'

export interface RoomDeps {
  ctx: any
  logger?: { info?(message: string): void; warn?(message: string): void }
}

export interface RoomResult {
  sessionId: string
  projectRoot: string
  created: boolean
  pinned: boolean
  detail: string
}

function service(ctx: any, key: string): any {
  return resolveService<any>(ctx, key)
}

/** 群聊会话标题：一眼看出是群，且带上群名。 */
export function roomTitle(groupTitle: string): string {
  return `[群聊] ${groupTitle}`
}

async function alive(ctx: any, sessionId: string): Promise<boolean> {
  if (sessionId === '') return false
  const agents = service(ctx, 'agents')
  try {
    if (agents?.get?.(sessionId) !== undefined) return true
  } catch {
    /* 继续查盘 */
  }
  const controller = service(ctx, 'sessionController')
  if (typeof controller?.list === 'function') {
    try {
      const list = await controller.list({}, new AbortController().signal)
      return (list?.items ?? []).some((item: any) => String(item?.sessionId) === sessionId)
    } catch {
      return false
    }
  }
  const query = service(ctx, 'sessionQuery')
  if (typeof query?.listSessions === 'function') {
    try {
      const rows = (await query.listSessions()) as any[]
      return rows.some((row) => String(row?.header?.id) === sessionId)
    } catch {
      return false
    }
  }
  return false
}

/** 这个会话是否仍是空会话（空会话在侧边栏里不可见）。查不到就当作不空。 */
async function isBlank(ctx: any, sessionId: string): Promise<boolean> {
  const controller = service(ctx, 'sessionController')
  if (typeof controller?.list !== 'function') return false
  try {
    const list = await controller.list({}, new AbortController().signal)
    const item = (list?.items ?? []).find((row: any) => String(row?.sessionId) === sessionId)
    return item?.blank === true
  } catch {
    return false
  }
}

/** 宿主 pin = 会话列表里常驻最前（registry 级 pin 集合，前置）。 */
async function pin(ctx: any, sessionId: string): Promise<boolean> {
  const registry = service(ctx, 'workspaceRegistry')
  if (typeof registry?.pinSession !== 'function') return false
  try {
    await registry.pinSession(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * 往群聊会话里写一条开场消息，让它脱离 blank 状态。
 *
 * 为什么必须写：侧边栏只显示**非空**会话（blank 的行是"新建会话"占位，会被隐去），
 * 所以一个建好但没有任何消息的会话在列表里不可见。
 *
 * 为什么用 prompt 而不是 inject：inject 只进 inbox，需要一轮 turn 消费才会
 * 落成 user/message 事件；而我们要的正是"有事件"。prompt 会真的跑一轮，
 * 这不是开销而是这个会话的本职：群聊会话要有内容才叫会话。
 */
async function seedRoom(deps: RoomDeps, controller: any, sessionId: string, group: Group): Promise<void> {
  if (typeof controller?.prompt !== 'function') {
    deps.logger?.warn?.('[dsh-pipeline-bot] 宿主没有 sessionController.prompt，群聊会话会因空会话而不显示')
    return
  }
  const roster = group.members
    .map((member) => member.name)
    .filter((name) => name !== '')
    .slice(0, 24)
    .join('、')
  const text = [
    `群聊「${group.title}」已建立。`,
    roster === '' ? '成员：待加入。' : `成员：${roster}。`,
    '这个会话是群聊的落点：群里的每条消息都会同步到这里，你可以在这里直接说话。',
    '不需要回复这条消息。',
  ].join('\n')
  try {
    // 第二个参数是必需的 AbortSignal（Remote 方法签名），漏传会报
    // `Cannot read properties of undefined (reading 'throwIfAborted')`
    const controllerSignal = new AbortController()
    await controller.prompt(
      {
        requestId: `pipeline-room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      controllerSignal.signal,
    )
    deps.logger?.info?.('[dsh-pipeline-bot] 群聊会话已写入开场消息（脱离空会话）')
  } catch (error) {
    deps.logger?.warn?.(`[dsh-pipeline-bot] 群聊会话开场消息写入失败：${String(error)}`)
  }
}

/**
 * 解析群聊会话应当落在哪个项目（必须是**已存在**的工作区）。
 *
 * 优先级：群的 `projectRoot` → 调用方/当前项目 → 宿主里第一个真实项目。
 * 全都没有就报错（不造目录）。
 */
export async function resolveRoomProject(
  deps: RoomDeps,
  group: Group,
  preferred?: string,
): Promise<{ workspaceId: string; projectRoot: string } | { error: string }> {
  const registry = service(deps.ctx, 'workspaceRegistry')
  if (typeof registry?.resolveByPath !== 'function') {
    return { error: '宿主没有 workspaceRegistry.resolveByPath，无法定位项目' }
  }
  const candidates: string[] = []
  for (const value of [preferred, group.projectRoot]) {
    if (typeof value === 'string' && value.trim() !== '') candidates.push(value.trim())
  }
  for (const root of candidates) {
    try {
      const workspace = await registry.resolveByPath(root)
      if (workspace !== undefined && workspace !== null) {
        return { workspaceId: workspace.id, projectRoot: root }
      }
    } catch {
      /* 该路径不是已存在的项目，试下一个 */
    }
  }
  /**
   * 显式指定过项目但都不存在 → 明确报错。
   * 曾经这里会兜底到「宿主里第一个项目」，等于把群聊会话**悄悄挪到无关项目**里 ——
   * 用户以为自己指定了 loop，实际落在别的项目，且没有任何提示。宁可不建，也不换位置。
   */
  if (candidates.length > 0) {
    return {
      error: `指定的项目不存在：${candidates.join(' / ')}。群聊会话必须落在已存在的项目里（不会自动建目录）。`,
    }
  }
  // 只有完全没指定时，才用宿主里第一个真实项目作为落点
  if (typeof registry.list === 'function') {
    try {
      const workspaces = registry.list() as any[]
      const real = workspaces.filter((item) => {
        const path = String(item?.path ?? '')
        return path !== '' && !path.includes('pipeline-bot') && path !== 'D:\\' && item?.title !== ''
      })
      if (real.length > 0) {
        return { workspaceId: real[0].id, projectRoot: String(real[0].path) }
      }
    } catch {
      /* 忽略 */
    }
  }
  return { error: '没有可用的项目：请先给群指定一个已存在的项目（群聊会话要落在项目里）' }
}

/**
 * 确保群在当前项目里有群聊会话，并在会话列表第一位。
 *
 * @param preferred 调用方所在项目（可选）；缺省用群记录的 projectRoot
 */
export async function ensureRoom(deps: RoomDeps, group: Group, preferred?: string): Promise<RoomResult> {
  const { ctx } = deps
  const controller = service(ctx, 'sessionController')
  const target = await resolveRoomProject(deps, group, preferred)
  if ('error' in target) {
    return { sessionId: '', projectRoot: '', created: false, pinned: false, detail: target.error }
  }
  const { workspaceId, projectRoot } = target

  // ① 已有且还活着：补 pin；若是空会话则补一条开场消息（否则侧边栏看不见它）
  const existing = group.roomSessionId ?? ''
  if (existing !== '' && (await alive(ctx, existing))) {
    if (await isBlank(ctx, existing)) {
      await seedRoom(deps, controller, existing, group)
    }
    const pinned = await pin(ctx, existing)
    return {
      sessionId: existing,
      projectRoot,
      created: false,
      pinned,
      detail: pinned ? '群聊会话已存在，已在会话列表第一位' : '群聊会话已存在（置顶失败）',
    }
  }

  if (typeof controller?.create !== 'function') {
    return { sessionId: existing, projectRoot, created: false, pinned: false, detail: '宿主没有 sessionController.create' }
  }

  let created: any
  try {
    // 宿主契约：session.create 只接受 workspaceId 或 cwd 之一。
    // 这里传 workspaceId —— 会话就落在那个已有项目的会话列表里。
    created = await controller.create({ workspaceId })
  } catch (error) {
    return { sessionId: existing, projectRoot, created: false, pinned: false, detail: `建群聊会话失败：${String(error)}` }
  }
  const sessionId = String(created?.sessionId ?? '')
  if (sessionId === '') {
    return { sessionId: existing, projectRoot, created: false, pinned: false, detail: '建群聊会话返回空 id' }
  }

  if (typeof controller.rename === 'function') {
    try {
      await controller.rename({ sessionId, title: roomTitle(group.title) })
    } catch (error) {
      deps.logger?.warn?.(`[dsh-pipeline-bot] 群聊会话改名失败：${String(error)}`)
    }
  }

  // 让会话不再是「空会话」。
  // 宿主侧边栏的可见性判断是：`blank && id !== current → 隐藏`
  // （dsh-client-ui-workspace lib/client.js:966）。
  // 新建的会话没有任何消息，blank=true，于是**建了也看不见** —— 实测踩过。
  // 这里写一条开场消息，让它成为有内容的普通会话。
  await seedRoom(deps, controller, sessionId, group)

  const pinned = await pin(ctx, sessionId)
  deps.logger?.info?.(`[dsh-pipeline-bot] 已在项目 ${projectRoot} 建群聊会话 ${sessionId}（pin=${pinned}）`)
  return {
    sessionId,
    projectRoot,
    created: true,
    pinned,
    detail: pinned ? `已在项目里建群聊会话并置于会话列表第一位` : '已在项目里建群聊会话（置顶失败）',
  }
}

/** 把一条群消息推进群聊会话（人打开那个会话就能看到完整对话）。 */
export async function postToRoom(
  deps: RoomDeps,
  sessionId: string,
  text: string,
): Promise<{ ok: boolean; detail: string }> {
  if (sessionId === '') return { ok: false, detail: '没有群聊会话' }
  const agents = service(deps.ctx, 'agents')
  let agent: any
  try {
    agent = agents?.get?.(sessionId)
  } catch {
    agent = undefined
  }
  if (agent === undefined) {
    return { ok: false, detail: '群聊会话未激活（消息已在群记录里，打开它即可看到）' }
  }
  try {
    const mod = await import('@deepseek-ai/dsh-llm').catch(() => undefined as any)
    const build = (mod as any)?.createUserMessage
    const message =
      typeof build === 'function'
        ? build({
            source: { kind: 'user', origin: 'dsh-pipeline-bot', from: 'pipeline-bot' },
            content: [{ type: 'text', text }],
          })
        : { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }], id: `room-${Date.now()}` }
    if (typeof agent.inject === 'function') agent.inject(message)
    else agent.send?.(message, 'next-step', false)
    return { ok: true, detail: '已进群聊会话' }
  } catch (error) {
    return { ok: false, detail: `写入群聊会话失败：${String(error)}` }
  }
}
