#!/usr/bin/env node
/**
 * 自检脚本 —— 这个仓库的「能装、能用」判据。
 *
 * 分三层，任一红灯即失败（退出码 1）：
 *   A. 清单与产物：package.json 的 dsh.client 声明、exports、产物语法
 *   B. Client 半形态：必须是经典脚本（不能带 ESM 关键字），否则宿主注入即语法错误
 *   C. 功能行为：用假宿主跑一遍「建群 → 加成员 → 人说话 → 跨项目派活 → 回执闭环 → 外部产品收件箱」
 *
 * 为什么 C 层用假宿主而不是真宿主：宿主是别人的进程，CI 里没有；
 * 但协作语义（谁被唤醒、回执叫醒谁）必须能独立验证，否则回归靠肉眼。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const problems = []
const ok = (label) => console.log(`  ✓ ${label}`)
const bad = (label, detail) => {
  problems.push(`${label}${detail === undefined ? '' : `：${detail}`}`)
  console.log(`  ✗ ${label}${detail === undefined ? '' : `：${detail}`}`)
}

// ── A. 清单与产物 ──
console.log('A. 清单与产物')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
pkg.dsh?.client?.platform === 'web'
  ? ok('dsh.client.platform = web')
  : bad('dsh.client.platform 缺失', '侧栏入口不会加载')
typeof pkg.exports?.['./client'] === 'string'
  ? ok(`exports["./client"] = ${pkg.exports['./client']}`)
  : bad('exports["./client"] 缺失')
typeof pkg.exports?.['.'] === 'object' && pkg.exports['.'].types
  ? ok('宿主入口与 types 已声明')
  : bad('宿主入口 exports["."] 不完整')

const libDir = join(root, 'lib')
if (!existsSync(join(libDir, 'index.js'))) {
  bad('lib/index.js 不存在', '先跑 npm run build')
} else {
  const files = readdirSync(libDir).filter((name) => name.endsWith('.js'))
  let syntaxBroken = 0
  for (const name of files) {
    try {
      execFileSync(process.execPath, ['--check', join(libDir, name)], { stdio: 'pipe' })
    } catch {
      syntaxBroken += 1
      bad(`lib/${name} 语法错误`)
    }
  }
  if (syntaxBroken === 0) ok(`lib 下 ${files.length} 个产物语法通过`)
}

// ── B. Client 半形态 ──
console.log('B. Client 半形态（经典脚本）')
const clientPath = join(libDir, 'client.js')
if (!existsSync(clientPath)) {
  bad('lib/client.js 不存在')
} else {
  const client = readFileSync(clientPath, 'utf8')
  client.includes('window.__ModuleLoader__.load(')
    ? ok('以 window.__ModuleLoader__.load 注册')
    : bad('未以 ModuleLoader.load 注册')
  const hasEsm = /^\s*(export|import)\s/m.test(client)
  if (hasEsm) bad('产物含 ESM 关键字', '经典脚本里 export/import 是语法错误，宿主注册会失败')
  else ok('不含 ESM 关键字')
  if (!client.includes('/plugins/dsh-pipeline-bot')) bad('Client 未指向自身 HTTP 面')
  else ok('Client 走 /plugins/dsh-pipeline-bot 数据面')
}

// ── C. 功能行为 ──
console.log('C. 功能行为（假宿主）')
process.env.DSH_HOME = join(root, '.selftest-home')
const { GroupBus } = await import(new URL('../lib/bus.js', import.meta.url).href)
const store = await import(new URL('../lib/store.js', import.meta.url).href)
const { inboxFor } = await import(new URL('../lib/bridge.js', import.meta.url).href)

const woken = []
const agent = (id) => ({
  id,
  phase: { kind: 'idle' },
  steer() {
    woken.push(id)
  },
  followup() {},
  inject() {},
  wakeDriver() {},
  options: { provider: 'p', model: 'm' },
})
const live = new Map([
  ['s-lead', agent('s-lead')],
  ['s-b', agent('s-b')],
  ['s-c', agent('s-c')],
])
const sessions = [
  { sessionId: 's-lead', cwd: 'D:/pA', updatedAt: 3, agentAvailable: true, projections: { values: { title: '管线维护' } } },
  { sessionId: 's-b', cwd: 'D:/pB', updatedAt: 2, agentAvailable: true, projections: { values: { title: 'chapter' } } },
  { sessionId: 's-c', cwd: 'D:/pC', updatedAt: 1, agentAvailable: true, projections: { values: { title: 'gate' } } },
]
const ctx = {
  get(name) {
    if (name === 'sessionController') {
      return { list: async () => ({ items: sessions }), create: async () => ({ sessionId: 's-room' }), rename: async () => ({}), prompt: async () => ({ accepted: true }) }
    }
    if (name === 'agents') return { get: (id) => live.get(id), list: () => [...live.values()], currentInitiator: () => undefined }
    if (name === 'agentLoop') return { resume: async () => ({ agent: agent('resumed') }) }
    if (name === 'workspaceRegistry') {
      return {
        list: () => [
          { id: 'wA', title: 'pA', path: 'D:/pA', sessionIds: [] },
          { id: 'wB', title: 'pB', path: 'D:/pB', sessionIds: [] },
          { id: 'wC', title: 'pC', path: 'D:/pC', sessionIds: [] },
        ],
        resolveByPath: async (path) => {
          const map = { 'D:/pA': 'wA', 'D:/pB': 'wB', 'D:/pC': 'wC' }
          return map[path] === undefined ? undefined : { id: map[path], path }
        },
        pinSession: async () => {},
        delete: async () => true,
        archiveSession: async () => {},
      }
    }
    return undefined
  },
}

const group = await store.createGroup('自检群', '管线维护', 'D:/pA')
await store.addMember(group.id, { name: 'chapter', sessionId: 's-b' })
await store.addMember(group.id, { name: 'gate', sessionId: 's-c' })
await store.addMember(group.id, { name: 'mavis', product: 'Mavis' })
const bus = new GroupBus({ ctx, groupId: group.id, logger: { info() {}, warn() {} } })

const members = await bus.members()
const names = members.members.map((m) => `${m.name}[${m.role}]`)
const expectMembers = ['管线维护[lead]', 'chapter[worker]', 'gate[worker]', 'mavis[external]']
JSON.stringify(names) === JSON.stringify(expectMembers)
  ? ok(`成员发现（跨项目 + 外部）：${names.join(' ')}`)
  : bad('成员发现不符', `实际 ${names.join(' ')}，期望 ${expectMembers.join(' ')}`)

const candidates = members.candidates.length
candidates === 3 ? ok(`候选池 ${candidates} 个会话`) : bad('候选池数量不符', String(candidates))

woken.length = 0
const human = await bus.speak({ from: '我', role: 'human', text: '跑第三章' })
human.targets[0] === '管线维护' && woken[0] === 's-lead'
  ? ok('人说话不 @ → 交给组长并唤醒')
  : bad('人说话路由不符', `targets=${human.targets} woken=${woken}`)

woken.length = 0
const assign = await bus.assign('复核时间线', ['gate', 'mavis'], { from: 'chapter' })
assign.task.deliveries.gate?.startsWith('steered')
  ? ok('跨项目派活 → 目标被 steer 唤醒')
  : bad('派活投递不符', JSON.stringify(assign.task.deliveries))
assign.task.deliveries.mavis?.includes('收件箱')
  ? ok('外部产品派活 → 进收件箱（降级不丢）')
  : bad('外部产品投递不符', JSON.stringify(assign.task.deliveries))

woken.length = 0
const report = await bus.report('复核通过', { from: 'gate', taskId: assign.task.id })
report.woke.includes('chapter') && woken.includes('s-b')
  ? ok('回执 → 唤醒派活人（不是组长）')
  : bad('回执唤醒不符', `woke=${report.woke} woken=${woken}`)

woken.length = 0
await bus.report('润色完成', { from: 'mavis', taskId: assign.task.id })
const dup = woken.filter((id) => id === 's-b').length
dup === 1 ? ok('回执收齐 → 只唤醒一次（无重复）') : bad('回执收齐重复唤醒', `s-b 被唤醒 ${dup} 次`)
const done = await store.findTask(group.id, assign.task.id)
done?.status === 'reported' ? ok('任务状态收口为 reported') : bad('任务状态不符', String(done?.status))

const room = await bus.ensureRoomSession('D:/pA')
room === 's-room' ? ok('群聊会话落在指定项目') : bad('群聊会话 id 不符', room)
const anchored = await store.getGroup(group.id)
anchored.projectRoot === 'D:/pA' ? ok('群元数据记录锚定项目') : bad('锚定项目未记录', String(anchored.projectRoot))

// 不存在的项目必须报错而不是换项目
const fake = { ...anchored, projectRoot: 'C:\\definitely-not-a-project', roomSessionId: undefined }
const roomMod = await import(new URL('../lib/room.js', import.meta.url).href)
const resolved = await roomMod.resolveRoomProject({ ctx, logger: { info() {}, warn() {} } }, fake)
resolved.error !== undefined
  ? ok('指定项目不存在 → 明确报错（不伪造目录/不换项目）')
  : bad('不存在的项目未报错', JSON.stringify(resolved))

// 外部收件箱筛选
const inbox = inboxFor(
  [
    { id: 'm1', ts: 1, from: 'chapter', role: 'member', text: '@mavis 帮忙看下', kind: 'report' },
    { id: 'm2', ts: 2, from: 'gate', role: 'member', text: '无关消息', kind: 'report' },
  ],
  'mavis',
  0,
)
inbox.length === 1 && inbox[0].reason === 'mention'
  ? ok('外部收件箱只收 @ 自己的消息')
  : bad('外部收件箱筛选不符', JSON.stringify(inbox))

// E. 参数健壮性与成员身份（回归：模型传非字符串参数曾让工具抛 TypeError）
console.log('E. 参数健壮性与成员身份')
const { asText, asTextList, memberIdOf, avatarOf, colorOf } = await import(new URL('../lib/util.js', import.meta.url).href)

for (const [label, value] of [
  ['对象', { group: 'x' }],
  ['数组', ['a', 'b']],
  ['null', null],
  ['undefined', undefined],
  ['数字', 42],
]) {
  let threw = false
  try {
    asText(value)
  } catch {
    threw = true
  }
  threw ? bad(`asText(${label}) 抛错`) : ok(`asText(${label}) 不抛错 → ${JSON.stringify(asText(value)).slice(0, 24)}`)
}
asTextList('a').length === 1 && asTextList(['a', { b: 1 }]).length === 2
  ? ok('asTextList 接受字符串与数组')
  : bad('asTextList 行为不符')

// 群标识解析：曾经 `(ref ?? '').trim()` 在 ref 为对象时抛 TypeError
{
  const storeMod = await import(new URL('../lib/store.js', import.meta.url).href)
  const g = await storeMod.createGroup('参数健壮群', '组长', 'D:/pA')
  let threw = false
  try {
    // 复刻 index.ts 的解析路径：asText 后再 trim
    asText({ bad: true }).trim()
    asText(['x']).trim()
  } catch {
    threw = true
  }
  threw ? bad('群标识解析对非字符串抛错（就是被报的 TypeError）') : ok('群标识解析对非字符串不抛错')
  await storeMod.deleteGroup(g.id)
}

// 成员 id / 头像：稳定且可区分
const idA = memberIdOf('chapter')
const idB = memberIdOf('chapter')
idA === idB ? ok(`成员 id 稳定：${idA}`) : bad('成员 id 不稳定')
memberIdOf('管线维护') !== memberIdOf('chapter') ? ok('不同成员 id 不同') : bad('成员 id 撞了')
const av1 = avatarOf('chapter', 'chapter')
const av2 = avatarOf('chapter', 'chapter')
av1.color === av2.color && av1.glyph === 'C'
  ? ok(`头像稳定且取首字：${av1.glyph} ${av1.color}`)
  : bad('头像不稳定', JSON.stringify([av1, av2]))
avatarOf('管线维护', '管线维护').glyph === '管' ? ok('中文名取首字作头像') : bad('中文头像不符')
new Set(['chapter', 'gate', '管线维护', 'mavis'].map((n) => memberIdOf(n))).size === 4
  ? ok('多成员 id 互不相同')
  : bad('成员 id 有重复')
// 显式 emoji 优先
avatarOf('x', 'x', { glyph: '🐳' }).glyph === '🐳' ? ok('显式 emoji 头像优先') : bad('显式头像未生效')

// D. 双向中继（群之所以是群，而不是某个 agent 的分身）
console.log('D. 双向中继')
const { assistantTextOf, installMemberMirror } = await import(new URL('../lib/mirror.js', import.meta.url).href)
const { humanTextOf, installRoomRelay } = await import(new URL('../lib/relay.js', import.meta.url).href)

assistantTextOf({ data: { message: { content: [{ type: 'text', text: '我改完了' }] } } }) === '我改完了'
  ? ok('成员回复正文可抽取')
  : bad('成员回复正文抽取失败')
assistantTextOf({ data: { message: { content: [{ type: 'tool-call', name: 'x' }] } } }) === undefined
  ? ok('纯工具调用不算发言')
  : bad('纯工具调用被当成发言')

humanTextOf([{ source: { kind: 'user' }, content: [{ type: 'text', text: '@gate 复核' }] }]) === '@gate 复核'
  ? ok('群会话里人的输入可抽取')
  : bad('人的输入抽取失败')
humanTextOf([{ source: { kind: 'user', origin: 'dsh-pipeline-bot' }, content: [{ type: 'text', text: '镜像' }] }]) === undefined
  ? ok('插件自己灌入的镜像消息被跳过（不会自我分派）')
  : bad('镜像消息未被跳过', '会导致无限循环')

// mirror：假 ctx 收集监听器，喂一条成员事件
const listeners = {}
const fakeCtx = { on(name, fn) { listeners[name] = fn; return () => { delete listeners[name] } } }
const recorded = []
const mirror = installMemberMirror({
  ctx: fakeCtx,
  groupsOfSession: async () => ['g1'],
  roomOfGroup: async () => 'room-1',
  record: async (sessionId, groupId, text) => { recorded.push({ sessionId, groupId, text }) },
})
listeners['session/event'](
  { header: { id: 's-b' } },
  { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '收到' }] } } },
)
await new Promise((r) => setTimeout(r, 50))
recorded.length === 1 && recorded[0].text === '收到'
  ? ok('成员会话的回复被写进群')
  : bad('镜像未写入群', JSON.stringify(recorded))
// 同一事件重复投递只记一次
listeners['session/event'](
  { header: { id: 's-b' } },
  { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '收到' }] } } },
)
await new Promise((r) => setTimeout(r, 50))
recorded.length === 1 ? ok('同一 event 不重复镜像') : bad('重复镜像', String(recorded.length))
mirror.dispose()

// relay：群会话的 pre-step 必须被 reject（不跑模型），且分派给人
let dispatchedText = null
const relay = installRoomRelay({
  ctx: fakeCtx,
  groupOfRoom: async (id) => (id === 'room-1' ? 'g1' : undefined),
  dispatch: async (_g, text) => { dispatchedText = text; return { targets: ['gate'] } },
})
const decision = await listeners['agent/pre-step'](
  { agent: { id: 'room-1' }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '@gate 复核' }] }], turn: 1, step: 1 },
  async () => ({ kind: 'enter', messages: [] }),
)
decision?.kind === 'reject' && dispatchedText === '@gate 复核'
  ? ok('群会话输入被分派，且不跑自身模型（reject）')
  : bad('群会话中继行为不符', `decision=${decision?.kind} dispatched=${dispatchedText}`)
// 非群会话不拦截
const passthrough = await listeners['agent/pre-step'](
  { agent: { id: 's-other' }, messages: [], turn: 1, step: 1 },
  async () => ({ kind: 'enter', messages: ['x'] }),
)
passthrough?.kind === 'enter' ? ok('普通会话不受影响') : bad('普通会话被误拦截')
relay.dispose()

// 清理自检数据
const { rmSync } = await import('node:fs')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

console.log('')
if (problems.length === 0) {
  console.log('全部通过 ✓')
  process.exit(0)
}
console.log(`失败 ${problems.length} 项：`)
for (const item of problems) console.log(`  - ${item}`)
process.exit(1)
