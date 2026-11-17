#!/usr/bin/env node
/**
 * 通用侧车：把**任何**外部 agent 产品接进项目群聊。
 *
 * 面向 WorkBuddy、Mavis 以及以后任何产品。它只做三件事：
 *   1. 以成员名向群注册（出现在成员列表里，可被 @）
 *   2. 长轮询收「发给我的」消息 → 交给产品的处理函数或命令
 *   3. 把产品的回复 / 回执发回群里 → 唤醒 DSH 侧的成员
 *
 * 用法（命令行，产品侧只需能执行命令即可）：
 *
 *   # 用命令做「产品适配器」：群消息 → stdin，产品输出 → 发回群
 *   node client.mjs \
 *     --base http://127.0.0.1:30454 --group "<群 id 或群名>" \
 *     --member mavis --product Mavis \
 *     --reply-cmd 'mavis ask --nonce-local'
 *
 *   # 只收发、不接模型（当作聊天客户端用）
 *   node client.mjs --base ... --group ... --member workbuddy --product WorkBuddy --stdin-pump
 *
 * 关键设计：**降级不丢消息**。产品不在跑时消息留在服务端收件箱，
 * 客户端下次带 cursor 续拉即可 —— 与 DSH 内部「会话不在进程就落库」同一条原则。
 */

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      index += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const base = String(args.base ?? process.env.PIPELINE_BOT_BASE ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
// 群标识（群 id 或群标题）；留空 = 宿主的当前群
const group = String(args.group ?? process.env.PIPELINE_BOT_GROUP ?? '')
const member = String(args.member ?? process.env.PIPELINE_BOT_MEMBER ?? '')
const product = String(args.product ?? process.env.PIPELINE_BOT_PRODUCT ?? 'external')
const key = String(args.key ?? process.env.PIPELINE_BOT_KEY ?? '')

if (member === '') {
  console.error('缺少 --member（群里显示的名字，例如 mavis / workbuddy）')
  process.exit(2)
}

const api = `${base}/plugins/dsh-pipeline-bot`
const headers = { 'content-type': 'application/json', 'x-pipeline-key': key }
const groupQuery = group === '' ? '' : `group=${encodeURIComponent(group)}`

async function call(path, options = {}) {
  const response = await fetch(`${api}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  })
  const text = await response.text()
  let json
  try {
    json = text === '' ? {} : JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${json?.error?.message ?? text}`)
  }
  return json
}

async function register(duty) {
  const result = await call('/bridge/register', {
    method: 'POST',
    body: JSON.stringify({ group, member, product, ...(duty === undefined ? {} : { duty }) }),
  })
  console.log(`已加入群聊：${member}（${product}）。群里现有：${result.roster.join('、')}`)
  return result
}

async function poll({ waitMs = 20000, ambient = true } = {}) {
  return call(
    `/bridge/poll?${groupQuery}${groupQuery === '' ? '' : '&'}member=${encodeURIComponent(member)}&wait=${waitMs}&ambient=${ambient ? 1 : 0}`,
    { method: 'GET' },
  )
}

async function post(text, extra = {}) {
  return call('/bridge/post', {
    method: 'POST',
    body: JSON.stringify({ group, member, product, text, ...extra }),
  })
}

async function report(text, taskId) {
  return call('/bridge/report', {
    method: 'POST',
    body: JSON.stringify({ group, member, product, text, ...(taskId === undefined ? {} : { taskId }) }),
  })
}

/** 用外部命令当产品适配器：消息进 stdin，标准输出就是回复。 */
async function runReplyCommand(command, item) {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', () => resolve({ stdout: stdout.trim(), stderr: stderr.trim() }))
    child.on('error', (error) => resolve({ stdout: '', stderr: String(error) }))
    child.stdin.end(JSON.stringify(item))
  })
}

async function main() {
  await register(args.duty === true ? undefined : args.duty)

  const replyCommand = args['reply-cmd'] === true ? undefined : args['reply-cmd']
  const ambient = args['no-ambient'] !== true

  if (args['stdin-pump'] === true) {
    // 交互模式：stdin 每行发一条群消息
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      const text = line.trim()
      if (text === '') return
      void post(text).then((result) => {
        console.log(`→ 群（唤醒 ${result.woke.map((item) => item.name).join('、') || '无'}）`)
      })
    })
    console.log('输入内容回车即发到群里（Ctrl+C 退出）')
    for (;;) {
      const batch = await poll({ waitMs: 20000, ambient })
      for (const item of batch.items) {
        console.log(`[群] ${item.from}（${item.reason}）：${item.text}`)
      }
      if (batch.items.length > 0) await call('/bridge/ack', { method: 'POST', body: JSON.stringify({ group, member, ids: batch.items.map((item) => item.id) }) })
    }
  }

  for (;;) {
    try {
      const batch = await poll({ waitMs: 20000, ambient })
      for (const item of batch.items) {
        console.log(`[群] ${item.from}（${item.reason}）：${item.text}`)
        if (replyCommand !== undefined) {
          const result = await runReplyCommand(replyCommand, item)
          if (result.stdout !== '') {
            if (item.reason === 'assign' && item.taskId !== undefined) await report(result.stdout, item.taskId)
            else await post(result.stdout)
            console.log(`[已回群] ${result.stdout.slice(0, 80)}`)
          } else if (result.stderr !== '') {
            console.error(`[适配器报错] ${result.stderr.slice(0, 200)}`)
          }
        }
      }
      if (batch.items.length > 0) {
        await call('/bridge/ack', { method: 'POST', body: JSON.stringify({ group, member, ids: batch.items.map((item) => item.id) }) })
      }
    } catch (error) {
      console.error(`[连接异常，5 秒后重试] ${String(error)}`)
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
}

export { register, poll, post, report, call }

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isMain) void main()
