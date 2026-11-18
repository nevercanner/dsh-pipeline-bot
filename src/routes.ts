/**
 * HTTP 面（给面板与外部产品用）。挂在 `ctx.webServer`。
 *
 * 裸路由不继承 Connection 鉴权栅栏，所以每个请求自己做一次
 * `ctx.connection.requestRejection(req)`（与 dsh-agent-teams / dsh-session-send 同款）。
 *
 * 路由（前缀 `/plugins/dsh-pipeline-bot`）：
 *   GET  /status                     装配诊断
 *   GET  /groups                     群列表
 *   POST /groups  {title}            新建群
 *   GET  /group?group=               群快照（成员/候选/消息/任务/bridgeKey/room）
 *   POST /say     {group,text}       人说话（不 @ 交给组长）
 *   POST /assign  {group,brief,targets,from}
 *   POST /member  {group,action,name,sessionId,duty,product}  加/删成员
 *   POST /room    {group}            确保群聊会话存在
 *   POST /clear   {group}            清空消息
 *   POST /rename  {group,title}      改群名
 * 外部产品桥接（需 x-pipeline-key）：
 *   POST /bridge/register  {group,member,product,duty}
 *   GET  /bridge/poll      ?group=&member=&wait=&ambient=
 *   POST /bridge/post      {group,member,text,targets}
 *   POST /bridge/report    {group,member,text,taskId}
 *   POST /bridge/ack       {group,member,ids}
 */
import type { GroupBus } from './bus.ts'
import { inboxFor } from './bridge.ts'
import * as store from './store.ts'
import { asText, asTextList, resolveService } from './util.ts'

export interface RouteDeps {
  ctx: any
  /** 按群标识（标题或 id；空 = 当前群）取 bus。 */
  busFor(group: string | undefined): Promise<GroupBus>
  statusOf: (group?: string) => Promise<Record<string, unknown>>
  /** 调用方所在项目（面板打开时把它作为群聊会话的落点）。 */
  currentProject?: () => string | undefined
  logger?: { warn?(message: string): void }
}

const PREFIX = '/plugins/dsh-pipeline-bot'
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function rejectionOf(ctx: any, req: any): number | undefined {
  try {
    const connection = resolveService<any>(ctx, 'connection')
    if (connection === undefined) return 503
    const rejection = connection.requestRejection(req)
    return rejection === undefined ? undefined : rejection
  } catch {
    return 503
  }
}

function sendJson(res: any, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function headerOf(req: any, name: string): string | undefined {
  try {
    const value = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()]
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

async function readJsonBody(req: any, maxBytes = 512 * 1024): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      req.off?.('error', onError)
      if (error !== undefined) {
        req.resume?.()
        reject(error)
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (chunk: any): void => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > maxBytes) finish(new Error('请求体过大'))
      else chunks.push(part)
    }
    const onEnd = (): void => finish()
    const onError = (): void => finish(new Error('请求体读取失败'))
    req.on?.('data', onData)
    req.on?.('end', onEnd)
    req.on?.('error', onError)
  })
  if (raw.trim() === '') return {}
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

/**
 * 解析「这次请求属于哪个群」。
 *
 * `body` 必须允许 undefined —— GET 路径没有请求体，早先这里直接读 `body['group']`
 * 就抛 `Cannot read properties of undefined (reading 'group')`，
 * 表现成面板/状态接口 500、连新建群与加成员都一起不可用。
 */
function groupOf(url: URL, body?: Record<string, unknown>): string | undefined {
  const fromQuery = asText(url.searchParams.get('group')).trim()
  if (fromQuery !== '') return fromQuery
  if (body === undefined || body === null) return undefined
  const fromBody = asText(body['group']).trim()
  return fromBody === '' ? undefined : fromBody
}

export function registerRoutes(deps: RouteDeps): () => void {
  const server = resolveService<any>(deps.ctx, 'webServer')
  if (typeof server?.register !== 'function') {
    deps.logger?.warn?.('[dsh-pipeline-bot] 宿主没有 webServer 服务，面板 HTTP 面不可用')
    return () => {}
  }

  const handler = async (req: any, res: any): Promise<void> => {
    const rejection = rejectionOf(deps.ctx, req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { error: { code: 'E_UNAUTHORIZED', message: '未通过连接鉴权' } })
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const route = url.pathname.slice(PREFIX.length) || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    try {
      if (method === 'GET' && route === '/status') {
        sendJson(res, 200, await deps.statusOf(groupOf(url, undefined)))
        return
      }
      if (method === 'GET' && route === '/groups') {
        sendJson(res, 200, { ok: true, groups: await store.listGroups() })
        return
      }
      /** 可锚定的项目（宿主里已存在的 workspace）：群聊会话要落在其中之一。 */
      if (method === 'GET' && route === '/projects') {
        const registry = resolveService<any>(deps.ctx, 'workspaceRegistry')
        let projects: Array<{ id: string; title: string; path: string; sessions: number }> = []
        if (typeof registry?.list === 'function') {
          try {
            projects = (registry.list() as any[])
              .filter((item) => String(item?.path ?? '') !== '' && item?.title !== '')
              .map((item) => ({
                id: String(item.id),
                title: String(item.title),
                path: String(item.path),
                sessions: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
              }))
          } catch {
            projects = []
          }
        }
        sendJson(res, 200, { ok: true, projects })
        return
      }
      if (method === 'GET' && route === '/group') {
        const bus = await deps.busFor(groupOf(url, undefined))
        const snapshot = await bus.snapshot(deps.currentProject?.())
        let origin: string | undefined
        try {
          origin = server.getOrigin?.()
        } catch {
          origin = undefined
        }
        sendJson(res, 200, {
          ok: true,
          groups: await store.listGroups(),
          group: snapshot.group,
          members: snapshot.members,
          candidates: snapshot.candidates.slice(0, 200),
          roomSessionId: snapshot.roomSessionId,
          bridgeKey: snapshot.bridgeKey,
          ...(origin === undefined ? {} : { origin }),
        })
        return
      }
      /** 外部产品拉取（长轮询）。 */
      if (method === 'GET' && route === '/bridge/poll') {
        const bus = await deps.busFor(groupOf(url, undefined))
        const group = await bus.group()
        const provided = headerOf(req, 'x-pipeline-key') ?? url.searchParams.get('key') ?? ''
        if (provided !== group.bridgeKey) {
          sendJson(res, 401, { error: { code: 'E_BAD_KEY', message: 'bridgeKey 不匹配（从 /group 的 bridgeKey 取）' } })
          return
        }
        const memberName = String(url.searchParams.get('member') ?? '').trim()
        if (memberName === '') throw new Error('poll 需要 member')
        const ambient = url.searchParams.get('ambient') === '1'
        const wait = Math.min(25_000, Math.max(0, Number(url.searchParams.get('wait') ?? '0') || 0))
        const collect = async () => {
          const fresh = await bus.group()
          return inboxFor(fresh.messages, memberName, 0, { ambient })
        }
        let items = await collect()
        if (items.length === 0 && wait > 0) {
          const deadline = Date.now() + wait
          while (Date.now() < deadline && items.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 400))
            items = await collect()
          }
        }
        sendJson(res, 200, { ok: true, group: group.id, member: memberName, items })
        return
      }

      if (method === 'POST') {
        const body = await readJsonBody(req)

        if (route.startsWith('/bridge/')) {
          const bus = await deps.busFor(groupOf(url, body))
          const group = await bus.group()
          const provided = headerOf(req, 'x-pipeline-key') ?? String(body['key'] ?? '')
          if (provided !== group.bridgeKey) {
            sendJson(res, 401, { error: { code: 'E_BAD_KEY', message: 'bridgeKey 不匹配' } })
            return
          }
          const memberName = asText(body['member']).trim()
          if (memberName === '') throw new Error('bridge 请求需要 member')
          const product = asText(body['product']).trim()

          if (route === '/bridge/register') {
            await bus.addMember({
              name: memberName,
              product: product === '' ? 'external' : product,
              ...(typeof body['duty'] === 'string' ? { duty: body['duty'] } : {}),
            })
            const { members } = await bus.members()
            sendJson(res, 200, { ok: true, member: memberName, roster: members.map((member) => member.name) })
            return
          }
          if (route === '/bridge/post') {
            const spoken = await bus.speak({
              from: memberName,
              role: 'external',
              kind: 'report',
              text: asText(body['text']),
              ...(asTextList(body['targets']).length === 0 ? {} : { targets: asTextList(body['targets']) }),
              ...(asText(body['taskId']).trim() === '' ? {} : { taskId: asText(body['taskId']).trim() }),
            })
            sendJson(res, 200, {
              ok: true,
              messageId: spoken.message.id,
              woke: spoken.deliveries.map((item) => ({ name: item.name, ok: item.ok, detail: item.detail })),
            })
            return
          }
          if (route === '/bridge/report') {
            const bridgedTaskId = asText(body['taskId']).trim()
            const result = await bus.report(asText(body['text']), {
              from: memberName,
              ...(bridgedTaskId === '' ? {} : { taskId: bridgedTaskId }),
            })
            sendJson(res, 200, { ok: true, task: result.task?.id ?? null, woke: result.woke })
            return
          }
          if (route === '/bridge/ack') {
            sendJson(res, 200, { ok: true })
            return
          }
          sendJson(res, 404, { error: { code: 'E_ROUTE', message: `未知 bridge 路由 ${route}` } })
          return
        }

        if (route === '/groups') {
          const projectRoot = asText(body['projectRoot']).trim()
          const group = await store.createGroup(
            asText(body['title']),
            asText(body['leadName']),
            projectRoot === '' ? undefined : projectRoot,
          )
          sendJson(res, 200, { ok: true, group })
          return
        }
        /** 改群的锚定项目（群聊会话会落到该项目的会话列表第一位）。 */
        if (route === '/project') {
          const bus = await deps.busFor(groupOf(url, body))
          const group = await store.setGroupProject(bus.groupId, asText(body['projectRoot']))
          sendJson(res, 200, { ok: true, group })
          return
        }
        const bus = await deps.busFor(groupOf(url, body))
        if (route === '/say') {
          const result = await bus.speak({
            from: asText(body['from']).trim() === '' ? '我' : asText(body['from']).trim(),
            role: 'human',
            kind: 'human',
            text: asText(body['text']),
          })
          sendJson(res, 200, { ok: true, targets: result.targets, deliveries: result.deliveries, note: result.note })
          return
        }
        if (route === '/assign') {
          const targets = asTextList(body['targets'])
          const from = asText(body['from']).trim()
          const result = await bus.assign(asText(body['brief']), targets, from === '' ? {} : { from })
          sendJson(res, 200, { ok: true, task: result.task })
          return
        }
        if (route === '/member') {
          const action = asText(body['action']).trim() || 'add'
          if (action === 'remove') {
            const group = await bus.removeMember(asText(body['name']) || asText(body['sessionId'] as string))
            sendJson(res, 200, { ok: true, members: group.members })
            return
          }
          const memberName = asText(body['name']).trim()
          const sessionId = asText(body['sessionId']).trim()
          if (memberName === '') throw new Error('添加成员需要 name')
          const duty = asText(body['duty']).trim()
          const product = asText(body['product']).trim()
          const explicitId = asText(body['id']).trim()
          const glyph = asText(body['glyph']).trim()
          const image = asText(body['image']).trim()
          const group = await bus.addMember({
            name: memberName,
            ...(sessionId === '' ? {} : { sessionId }),
            ...(duty === '' ? {} : { duty }),
            ...(product === '' ? {} : { product }),
            ...(explicitId === '' ? {} : { id: explicitId }),
            ...(glyph === '' ? {} : { glyph }),
            ...(image === '' ? {} : { image }),
          })
          sendJson(res, 200, { ok: true, members: group.members })
          return
        }
        if (route === '/clear') {
          const group = await bus.clear()
          await store.appendMessage(group.id, { from: 'system', role: 'system', kind: 'system', text: '群消息已清空。' })
          sendJson(res, 200, { ok: true, cleared: group.messages.length })
          return
        }
        if (route === '/rename') {
          const group = await store.renameGroup(bus.groupId, asText(body['title']))
          sendJson(res, 200, { ok: true, group })
          return
        }
      }
      sendJson(res, 404, { error: { code: 'E_ROUTE', message: `未知路由 ${method} ${route}` } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { error: { code: 'E_INTERNAL', message } })
    }
  }

  return server.register({ path: PREFIX, handler })
}
