/**
 * 群存储：**群是全局一等实体**，不按项目分桶。
 *
 * 落盘 `$DSH_HOME/pipeline-bot/groups.json`：
 *   { version: 2, defaultGroupId, groups: { [id]: Group } }
 *
 * 为什么不用 sqlite：群的量级是「几个群、每群几十条消息、几个任务」，
 * JSON 原子写（tmp + rename）足够，安装路径上也不用多一个原生依赖。
 *
 * 为什么 v1（按项目 hash 分桶）要迁移：那样群被绑死在项目上，
 * 跨项目协作根本表达不出来。迁移策略见 `load()`：旧的按项目群升级为一个
 * 独立群，标题取项目名，成员按原 pinned 保留 —— 数据不丢、语义变宽。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { newBridgeKey } from './bridge.ts'
import { DEFAULT_GROUP_TITLE, DEFAULT_LEAD_NAME } from './types.ts'
import type { Group, MemberRecord, Message, Task } from './types.ts'
import { baseName, shortRandom, stableId } from './util.ts'

const MAX_MESSAGES = 400
const MAX_TASKS = 120
const MAX_GROUPS = 24

export function dataDir(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'pipeline-bot')
}

function filePath(): string {
  return join(dataDir(), 'groups.json')
}

interface StoreShape {
  version: 2
  defaultGroupId: string
  groups: Record<string, Group>
}

/**
 * 不保留长驻内存 cache：热重载会同时存在**两个模块实例**（旧实例尚未 dispose），
 * 各自持 cache 会互相覆盖对方刚写的文件（实测：刚建好的群聊会话 id 被旧实例的
 * 空 cache 冲掉）。群数据很小，每次读盘 + 串行写就足够，且天然多实例安全。
 */
let writing: Promise<void> = Promise.resolve()

/** 老版本（v1：按项目 hash 分桶）→ v2 独立群。 */
function migrateV1(raw: any): { groups: Record<string, Group>; migrated: number } {
  const groups: Record<string, Group> = {}
  let migrated = 0
  const legacy = raw?.groups
  if (legacy !== null && typeof legacy === 'object' && !Array.isArray(legacy)) {
    for (const [key, value] of Object.entries(legacy as Record<string, any>)) {
      if (value === null || typeof value !== 'object') continue
      const projectRoot = typeof value.projectRoot === 'string' ? value.projectRoot : ''
      const id = `g-${stableId(projectRoot || key)}`
      const members: MemberRecord[] = []
      const leadName = typeof value.leadName === 'string' && value.leadName !== '' ? value.leadName : DEFAULT_LEAD_NAME
      members.push({ name: leadName, role: 'lead', addedAt: Date.now() })
      for (const pinned of Array.isArray(value.pinned) ? value.pinned : []) {
        if (pinned === null || typeof pinned !== 'object') continue
        const sessionId = typeof pinned.sessionId === 'string' ? pinned.sessionId : ''
        if (sessionId === '') continue
        members.push({
          name: typeof pinned.name === 'string' && pinned.name !== '' ? pinned.name : sessionId.slice(0, 10),
          sessionId,
          role: 'worker',
          ...(typeof pinned.duty === 'string' ? { duty: pinned.duty } : {}),
          addedAt: Date.now(),
        })
      }
      groups[id] = {
        id,
        title: projectRoot === '' ? DEFAULT_GROUP_TITLE : `${baseName(projectRoot)} 项目群`,
        leadName,
        members,
        messages: Array.isArray(value.messages) ? value.messages : [],
        tasks: Array.isArray(value.tasks) ? value.tasks : [],
        ...(typeof value.roomSessionId === 'string' ? { roomSessionId: value.roomSessionId } : {}),
        bridgeKey: newBridgeKey(),
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
        updatedAt: Date.now(),
      }
      migrated += 1
    }
  }
  return { groups, migrated }
}

async function load(): Promise<StoreShape> {
  const file = filePath()
  if (!existsSync(file)) return { version: 2, defaultGroupId: '', groups: {} }
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
    if (raw.version === 2 && raw.groups !== null && typeof raw.groups === 'object') {
      return {
        version: 2,
        defaultGroupId: typeof raw.defaultGroupId === 'string' ? raw.defaultGroupId : '',
        groups: raw.groups as Record<string, Group>,
      }
    }
    // v1 → v2
    const { groups } = migrateV1(raw)
    const first = Object.keys(groups)[0] ?? ''
    const migrated: StoreShape = { version: 2, defaultGroupId: first, groups }
    await flush(migrated)
    return migrated
  } catch {
    // 坏库不覆盖：留备份，从空库开始
    try {
      await rename(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* 备份失败继续 */
    }
    return { version: 2, defaultGroupId: '', groups: {} }
  }
}

/** 序列化写盘：所有写操作排队，避免两个实例同时 tmp+rename 互相覆盖。 */
async function flush(store: StoreShape): Promise<void> {
  const snapshot = store
  const file = filePath()
  writing = writing
    .then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
      await rename(tmp, file)
    })
    .catch(() => undefined)
  await writing
}

function newGroup(title: string, leadName: string): Group {
  const now = Date.now()
  return {
    id: `g-${shortRandom('x').slice(2)}`,
    title: title.trim() === '' ? DEFAULT_GROUP_TITLE : title.trim(),
    leadName: leadName.trim() === '' ? DEFAULT_LEAD_NAME : leadName.trim(),
    members: [{ name: leadName.trim() === '' ? DEFAULT_LEAD_NAME : leadName.trim(), role: 'lead', addedAt: now }],
    messages: [],
    tasks: [],
    bridgeKey: newBridgeKey(),
    createdAt: now,
    updatedAt: now,
  }
}

/** 列出全部群（新建时按标题排序稳定）。 */
export async function listGroups(): Promise<Array<{ id: string; title: string; memberCount: number; updatedAt: number }>> {
  const store = await load()
  return Object.values(store.groups)
    .map((group) => ({
      id: group.id,
      title: group.title,
      memberCount: group.members.length,
      updatedAt: group.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 取默认群（不存在则建一个通用群 —— 「任何项目都能接入」的落脚点）。 */
export async function defaultGroup(): Promise<Group> {
  const store = await load()
  const existing = store.groups[store.defaultGroupId]
  if (existing !== undefined) return existing
  const first = Object.values(store.groups).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (first !== undefined) {
    store.defaultGroupId = first.id
    await flush(store)
    return first
  }
  const created = newGroup(DEFAULT_GROUP_TITLE, DEFAULT_LEAD_NAME)
  store.groups[created.id] = created
  store.defaultGroupId = created.id
  await flush(store)
  return created
}

export async function createGroup(
  title: string,
  leadName = DEFAULT_LEAD_NAME,
  projectRoot?: string,
): Promise<Group> {
  const store = await load()
  const group = newGroup(title, leadName)
  if (projectRoot !== undefined && projectRoot.trim() !== '') group.projectRoot = projectRoot.trim()
  if (Object.keys(store.groups).length >= MAX_GROUPS) {
    throw new Error(`群数量已达上限 ${MAX_GROUPS}`)
  }
  store.groups[group.id] = group
  store.defaultGroupId = group.id
  await flush(store)
  return group
}

export async function getGroup(groupId?: string): Promise<Group> {
  const store = await load()
  if (groupId === undefined || groupId === '') return defaultGroup()
  const group = store.groups[groupId]
  if (group === undefined) return defaultGroup()
  return group
}

export async function setDefaultGroup(groupId: string): Promise<Group> {
  const store = await load()
  const group = store.groups[groupId]
  if (group === undefined) throw new Error(`群不存在：${groupId}`)
  store.defaultGroupId = groupId
  await flush(store)
  return group
}

export async function deleteGroup(groupId: string): Promise<boolean> {
  const store = await load()
  if (store.groups[groupId] === undefined) return false
  delete store.groups[groupId]
  if (store.defaultGroupId === groupId) {
    store.defaultGroupId = Object.keys(store.groups)[0] ?? ''
  }
  await flush(store)
  return true
}

export async function renameGroup(groupId: string, title: string): Promise<Group> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  group.title = title.trim() === '' ? group.title : title.trim()
  group.updatedAt = Date.now()
  await flush(store)
  return group
}

export async function setLead(groupId: string, leadName: string): Promise<Group> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  const next = leadName.trim()
  if (next === '') return group
  const previous = group.leadName
  group.leadName = next
  group.members = group.members.filter((member) => member.name !== previous || member.sessionId !== undefined)
  if (!group.members.some((member) => member.name === next && member.role === 'lead')) {
    group.members.unshift({ name: next, role: 'lead', addedAt: Date.now() })
  }
  group.updatedAt = Date.now()
  await flush(store)
  return group
}

/** 加成员（同 sessionId 或同名视为同一人，幂等）。 */
export async function addMember(
  groupId: string,
  member: { name: string; sessionId?: string; role?: MemberRecord['role']; duty?: string; product?: string },
): Promise<Group> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  const name = member.name.trim()
  if (name === '') throw new Error('成员需要名字')
  const duplicated = group.members.some(
    (item) =>
      (member.sessionId !== undefined && member.sessionId !== '' && item.sessionId === member.sessionId) ||
      item.name.trim().toLowerCase() === name.toLowerCase(),
  )
  if (!duplicated) {
    group.members.push({
      name,
      ...(member.sessionId === undefined || member.sessionId === '' ? {} : { sessionId: member.sessionId }),
      role: member.role ?? (member.product === undefined ? 'worker' : 'external'),
      ...(member.duty === undefined ? {} : { duty: member.duty }),
      ...(member.product === undefined ? {} : { product: member.product }),
      addedAt: Date.now(),
    })
    group.updatedAt = Date.now()
    await flush(store)
  }
  return group
}

export async function removeMember(groupId: string, ref: string): Promise<Group> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  const wanted = ref.trim().toLowerCase()
  group.members = group.members.filter(
    (member) => member.sessionId !== ref && member.name.trim().toLowerCase() !== wanted,
  )
  group.updatedAt = Date.now()
  await flush(store)
  return group
}

export async function touchMember(groupId: string, name: string): Promise<void> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  const member = group.members.find((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase())
  if (member === undefined) return
  group.updatedAt = Date.now()
  await flush(store)
}

export async function appendMessage(
  groupId: string,
  message: Omit<Message, 'id' | 'ts'> & { id?: string; ts?: number },
): Promise<{ group: Group; message: Message }> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  const next: Message = {
    ...message,
    id: message.id ?? shortRandom('msg'),
    ts: message.ts ?? Date.now(),
  }
  group.messages.push(next)
  if (group.messages.length > MAX_MESSAGES) group.messages = group.messages.slice(-MAX_MESSAGES)
  group.updatedAt = next.ts
  await flush(store)
  return { group, message: next }
}

export async function upsertTask(groupId: string, task: Task): Promise<Task> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  const index = group.tasks.findIndex((item) => item.id === task.id)
  if (index >= 0) group.tasks[index] = task
  else group.tasks.push(task)
  if (group.tasks.length > MAX_TASKS) group.tasks = group.tasks.slice(-MAX_TASKS)
  group.updatedAt = Date.now()
  await flush(store)
  return task
}

export async function findTask(groupId: string, taskId?: string): Promise<Task | undefined> {
  const group = await getGroup(groupId)
  if (taskId === undefined || taskId === '') {
    return [...group.tasks].reverse().find((item) => item.status === 'dispatched')
  }
  return group.tasks.find((item) => item.id === taskId)
}

export async function setRoom(groupId: string, sessionId: string): Promise<Group> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  group.roomSessionId = sessionId
  group.updatedAt = Date.now()
  await flush(store)
  return group
}

/** 设定群的锚定项目（只影响群聊会话落在哪个项目里）。 */
export async function setGroupProject(groupId: string, projectRoot: string): Promise<Group> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  const next = projectRoot.trim()
  if (next !== '' && next !== group.projectRoot) {
    group.projectRoot = next
    // 换了项目：旧会话不再代表这个群，清掉让它在新区重建
    group.roomSessionId = undefined
    group.updatedAt = Date.now()
    await flush(store)
  }
  return group
}

export async function clearMessages(groupId: string): Promise<Group> {
  const store = await load()
  const group = store.groups[groupId] ?? (await defaultGroup())
  group.messages = []
  group.updatedAt = Date.now()
  await flush(store)
  return group
}


