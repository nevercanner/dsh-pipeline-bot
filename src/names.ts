/**
 * 把群成员名同步进 `dsh-session-send` 的名册（`<项目>/.dsh-bus/names.json`）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * 两套寻址各说各话：群成员名来自会话标题（如「创建一个带左侧栏入口的 DSH」），
 * 而会话总线的名册只认「已报名（dsh_bus_register）」的名字或 session id。
 * 实测后果：组长在群里看到成员叫 A，用 `dsh_bus_send` 发消息却报
 * 「目标不存在：A」—— 同一个群里的人，两个插件的名字对不上。
 *
 * 做法：成员加入群时，把 `{ sessionId: name }` 写进**该成员所属项目**的名册。
 * 规则刻意保守：
 *   · 只补空位，**不覆盖**已有名字（用户自己报的名优先）
 *   · 名册坏了不动它（那是别的插件的数据，宁可少同步也不破坏）
 *   · 写入用 tmp+rename，避免半截 JSON
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { asText, normalizePath } from './util.ts'

export interface NameSyncDeps {
  logger?: { warn?(message: string): void }
}

interface NamesFile {
  [sessionId: string]: { name?: string; at?: number }
}

async function readNames(file: string): Promise<NamesFile> {
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw as NamesFile
  } catch {
    return {}
  }
}

/**
 * 把一个成员名写进其项目名册。
 *
 * @param projectRoot 成员所属项目根（不是群的项目！名字要写进它会话所在项目的名册）
 * @param sessionId   完整 session id（含 `session-` 前缀，名册就用这个键）
 * @param name        群里的名字
 * @returns 是否真的写了
 */
export async function syncName(
  deps: NameSyncDeps,
  projectRoot: string,
  sessionId: string,
  name: string,
): Promise<boolean> {
  const root = normalizePath(asText(projectRoot))
  const id = asText(sessionId).trim()
  const label = asText(name).trim()
  if (root === '' || id === '' || label === '') return false
  const file = join(root, '.dsh-bus', 'names.json')
  try {
    const current = await readNames(file)
    const existing = current[id]
    // 已有非空名字：尊重它（用户/对方自己报的名优先，避免互相覆盖）
    if (existing !== undefined && typeof existing.name === 'string' && existing.name.trim() !== '') return false
    current[id] = { name: label, at: Date.now() }
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    return true
  } catch (error) {
    deps.logger?.warn?.(`[dsh-pipeline-bot] 同步成员名到总线名册失败（${root}）：${String(error)}`)
    return false
  }
}
