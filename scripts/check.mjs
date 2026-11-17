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
