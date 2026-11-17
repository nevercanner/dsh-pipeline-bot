/**
 * 候选池：宿主里**所有可加入群的 DSH 会话**（跨项目）。
 *
 * 关键转变：这里不再是「本项目成员发现」，而是「候选来源」。
 * 群不绑项目，所以候选必须跨项目；项目只是候选的一个标签。
 *
 * 数据来源（真机实测过的形状）：
 *   · `sessionController.list()` → sessionId / cwd / updatedAt / projections.values.title
 *     —— 标题只在这里有；`sessionQuery.listSessions()` 的 header 没有 title。
 *   · `agents.list()` → 活 Agent（live 标记）
 *   · `<项目>/.dsh-bus/names.json` → 自注册名（dsh-session-send 的报名机制）
 *
 * 名字解析优先级（群里 @ 用的名字）：
 *   手填名字 > 自注册名 > 标题里的 [方括号] > 标题本身（若像名字）
 *
 * 「像名字」的判定必须保守：会话标题往往是整段提问（"你是网文改写执行者。任务："），
 * 把那种标题当名字会让 @ 列表变成一堆句子。所以限制长度、排除标点与常见开头。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Candidate, Member, MemberRecord } from './types.ts'
import { baseName, normalizePath } from './util.ts'

const MAX_NAME_LENGTH = 16
/** 明显是「一句话」而不是「一个名字」的开头。 */
const SENTENCE_STARTS = ['你', '请', '帮我', '我们', '作为', '根据', 'the ', 'please ', 'you ', 'help ']

function service(ctx: any, key: string): any {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    if (viaGet !== undefined) return viaGet
  } catch {
    /* 落到属性访问 */
  }
  try {
    return ctx?.[key]
  } catch {
    return undefined
  }
}

/** 标题本身是否可以直接当名字用。 */
export function usableName(title: string | undefined): string | undefined {
  if (typeof title !== 'string') return undefined
  const text = title.trim()
  if (text === '') return undefined
  if (text.length > MAX_NAME_LENGTH) return undefined
  if (/[。！？!?，,；;：:\n\r]/.test(text)) return undefined
  const lower = text.toLowerCase()
  if (SENTENCE_STARTS.some((prefix) => lower.startsWith(prefix))) return undefined
  return text
}

/** 标题里的 `[chapter] …` / `【cast】…` 提取。 */
export function bracketName(title: string | undefined): string | undefined {
  if (typeof title !== 'string') return undefined
  const match = /^\s*[[【]\s*([^\]】]{1,24}?)\s*[\]】]/.exec(title)
  return match === null ? undefined : match[1]!.trim()
}

/** 会话标题 → 群里的名字。 */
export function nameFromTitle(title: string | undefined): string | undefined {
  return bracketName(title) ?? usableName(title)
}

/** 读某项目里的自注册名册；key 是**完整 session id**（含 `session-` 前缀）。 */
async function readNames(index: Map<string, string>, projectRoot: string): Promise<void> {
  const file = join(projectRoot, '.dsh-bus', 'names.json')
  if (!existsSync(file)) return
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const name = value !== null && typeof value === 'object' ? (value as any).name : undefined
      if (typeof name !== 'string' || name.trim() === '') continue
      // 曾经在这里剥掉 `session-` 前缀 —— 真机上会话 id **本身就带**这个前缀，
      // 剥了等于永远匹配不上（129 个会话一个都认不出来）。原样存，另存一份去前缀别名。
      index.set(key, name.trim())
      index.set(key.replace(/^session-/, ''), name.trim())
    }
  } catch {
    /* 名册坏了就当作没有 */
  }
}

export interface CandidatePool {
  candidates: Candidate[]
  /** 所有出现过的项目根（给「按项目筛选」用）。 */
  projects: string[]
}

/**
 * 扫全部会话，产出候选池。
 * @param namesBySession session id → 名字（由调用方预先收集，含所有项目的自注册名）
 */
export async function listCandidates(
  ctx: any,
  options: { namesBySession?: Map<string, string>; logger?: { warn?(m: string): void } } = {},
): Promise<CandidatePool> {
  const names = options.namesBySession ?? new Map<string, string>()
  const liveIds = new Set<string>()

  const agents = service(ctx, 'agents')
  if (typeof agents?.list === 'function') {
    try {
      for (const agent of agents.list() as any[]) {
        const id = String(agent?.id ?? '')
        if (id !== '') liveIds.add(id)
      }
    } catch {
      /* 活 Agent 列表拿不到不影响候选 */
    }
  }

  interface Row {
    id: string
    cwd?: string
    title?: string
    updatedAt?: number
  }
  const rows = new Map<string, Row>()

  // ① 首选 sessionController.list()：唯一带标题与活跃时间的来源
  const controller = service(ctx, 'sessionController')
  if (typeof controller?.list === 'function') {
    try {
      const list = await controller.list({}, new AbortController().signal)
      for (const item of list?.items ?? []) {
        const id = String(item?.sessionId ?? '')
        if (id === '') continue
        const title = item?.projections?.values?.title
        rows.set(id, {
          id,
          ...(typeof item?.cwd === 'string' ? { cwd: item.cwd } : {}),
          ...(typeof title === 'string' ? { title } : {}),
          ...(typeof item?.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
        })
      }
    } catch (error) {
      options.logger?.warn?.(`读 sessionController.list() 失败：${String(error)}`)
    }
  }

  // ② 兜底 sessionQuery.listSessions()（无标题，但能拿到 cwd / live）
  if (rows.size === 0) {
    const query = service(ctx, 'sessionQuery')
    if (typeof query?.listSessions === 'function') {
      try {
        const list = (await query.listSessions()) as any[]
        for (const item of list) {
          const header = item?.header ?? {}
          const id = String(header.id ?? '')
          if (id === '') continue
          rows.set(id, {
            id,
            ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
            ...(typeof header.title === 'string' ? { title: header.title } : {}),
            ...(typeof header.createdAt === 'number' ? { updatedAt: header.createdAt } : {}),
          })
        }
      } catch (error) {
        options.logger?.warn?.(`读 sessionQuery.listSessions() 失败：${String(error)}`)
      }
    }
  }

  // ③ 自注册名：对每个出现过的项目根读一次
  const roots = new Set<string>()
  for (const row of rows.values()) {
    if (row.cwd !== undefined && row.cwd !== '') roots.add(normalizePath(row.cwd))
  }
  for (const root of roots) await readNames(names, root)

  const candidates: Candidate[] = []
  for (const row of rows.values()) {
    const selfName = names.get(row.id)
    const name = selfName ?? nameFromTitle(row.title) ?? row.id.slice(0, 10)
    const cwd = row.cwd === undefined ? undefined : normalizePath(row.cwd)
    candidates.push({
      sessionId: row.id,
      name,
      ...(cwd === undefined ? {} : { cwd, project: baseName(cwd) }),
      status: liveIds.has(row.id) ? 'live' : 'inactive',
      added: false,
      ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
    })
  }
  candidates.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'live' ? -1 : 1
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
  return { candidates, projects: [...roots] }
}

/** 收集所有相关项目的自注册名（跨项目）。 */
export async function collectNames(ctx: any): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const registry = service(ctx, 'workspaceRegistry')
  if (typeof registry?.list === 'function') {
    try {
      for (const workspace of registry.list() as any[]) {
        const path = typeof workspace?.path === 'string' ? workspace.path : ''
        if (path !== '') await readNames(names, normalizePath(path))
      }
    } catch {
      /* 工作区列表拿不到就只靠会话 cwd */
    }
  }
  return names
}

/** 把成员登记解析成带状态的成员（现算在线状态与项目标签）。 */
export function resolveMembers(
  records: readonly MemberRecord[],
  candidates: readonly Candidate[],
  extras: readonly Member[] = [],
): Member[] {
  const byId = new Map(candidates.map((item) => [item.sessionId, item]))
  const byName = new Map(candidates.map((item) => [item.name.toLowerCase(), item]))
  const out: Member[] = []

  for (const record of records) {
    const candidate =
      record.sessionId !== undefined && record.sessionId !== ''
        ? byId.get(record.sessionId)
        : byName.get(record.name.toLowerCase())
    if (record.role === 'external') {
      const extra = extras.find((item) => item.name.toLowerCase() === record.name.toLowerCase())
      out.push({
        name: record.name,
        sessionId: '',
        role: 'external',
        status: extra?.status ?? 'inactive',
        product: record.product ?? extra?.product ?? 'external',
        ...(record.duty === undefined ? {} : { duty: record.duty }),
        ...(extra?.lastSeen === undefined ? {} : { lastSeen: extra.lastSeen }),
      })
      continue
    }
    if (candidate === undefined) {
      out.push({
        name: record.name,
        sessionId: record.sessionId ?? '',
        role: record.role,
        status: 'missing',
        ...(record.duty === undefined ? {} : { duty: record.duty }),
      })
      continue
    }
    out.push({
      name: record.name,
      sessionId: candidate.sessionId,
      role: record.role,
      status: candidate.status,
      ...(candidate.cwd === undefined ? {} : { cwd: candidate.cwd }),
      ...(candidate.project === undefined ? {} : { project: candidate.project }),
      ...(record.duty === undefined ? {} : { duty: record.duty }),
      ...(candidate.updatedAt === undefined ? {} : { seenAt: candidate.updatedAt }),
    })
  }
  return out
}
