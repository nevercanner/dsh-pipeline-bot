/**
 * 模型侧工具（每个 agent 都能用）。
 *
 * 全部支持可选 `group` 参数（群标题或 id）：不传就用「当前群」。
 * 这让同一批工具服务多个群 —— 群是全局实体，不绑项目。
 */
import type { GroupBus } from './bus.ts'
import { asText, asTextList } from './util.ts'
import type { Candidate, Member } from './types.ts'

export interface ToolIdentity {
  name: string
  role: 'lead' | 'member'
  sessionId: string
}

export interface ToolDeps {
  tools: { register(definition: any): () => void }
  /** 解析目标群 → bus（不传 group 时用当前/默认群）。 */
  busForCaller(exec: any, group?: string): Promise<GroupBus>
  identityOfCaller(exec: any, bus: GroupBus): Promise<ToolIdentity>
  logger?: { warn?(message: string): void }
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: any): Array<{ type: 'text'; text: string }>
  }
  execute(args: any, exec: any): Promise<unknown>
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const

function asResult(text: string) {
  return { text }
}

function renderResult(_args: unknown, value: any) {
  const body = typeof value?.text === 'string' ? value.text : JSON.stringify(value ?? null, null, 2)
  return [{ type: 'text' as const, text: body }]
}

function roster(members: readonly Member[]): string {
  return members
    .map((member) => {
      const role = member.role === 'lead' ? '组长' : member.role === 'external' ? `外部·${member.product ?? ''}` : '成员'
      const state = member.status === 'live' ? (member.role === 'external' ? '在线' : '醒着') : member.status === 'inactive' ? '离线' : '无会话'
      const where = member.project === undefined ? '' : ` @${member.project}`
      const glyph = member.avatar?.glyph ?? '?'
      return `- ${glyph} ${member.name}  [id: ${member.id ?? member.name}]（${role}·${state}${where}${member.duty === undefined ? '' : `：${member.duty}`}）`
    })
    .join('\n')
}

export function registerBusTools(deps: ToolDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  const register = (definition: ToolDefinition): void => {
    try {
      const off = deps.tools.register(definition)
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      deps.logger?.warn?.(`[dsh-pipeline-bot] 注册工具 ${definition.name} 失败：${String(error)}`)
    }
  }

  register({
    name: 'pipeline_say',
    description:
      '在**群聊**里发言（公共频道，不是私聊）。@ 到谁就同时唤醒谁 —— 这是成员之间互相协调的主通道：' +
      '回答别人、约定分工、追问、报告进展都走这里。被 @ 的成员各自在自己的会话里用独立上下文干活。' +
      '发言留在群历史里，人和所有成员都能看到。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的话。@成员名 会唤醒对方' },
        targets: { type: 'array', items: { type: 'string' }, description: '（可选）显式要唤醒的成员名（名字或成员 id），可多个' },
        silent: { type: 'boolean', description: '（可选）true = 只入群不唤醒' },
        group: { type: 'string', description: '（可选）群标题或 id；不传用当前群' },
      },
      required: ['text'],
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(args: any, exec: any) {
      const bus = await deps.busForCaller(exec, args?.group)
      const me = await deps.identityOfCaller(exec, bus)
      const targets = asTextList(args?.targets)
      const result = await bus.speak({
        from: me.name,
        role: me.role,
        kind: 'report',
        text: asText(args?.text),
        ...(targets.length === 0 ? {} : { targets }),
        silent: args?.silent === true,
      })
      const woke =
        result.deliveries.length === 0
          ? '（没有唤醒任何人）'
          : result.deliveries.map((item) => `→ ${item.name}：${item.ok ? item.detail : `失败（${item.detail}）`}`).join('\n')
      return asResult(`已发到群里（消息 ${result.message.id}）。\n唤醒：\n${woke}${result.note === '' ? '' : `\n提示：${result.note}`}`)
    },
  })

  register({
    name: 'pipeline_assign',
    description:
      '在群里**派活**：把一段明确的活派给一个或多个成员，同时唤醒他们（并行，各自独立上下文干活）。' +
      '派活登记成任务（taskId），被派的人做完用 pipeline_report 回执；回执齐了会自动唤醒派活人收尾。' +
      '成员可以来自任何项目，也可以是不在 DSH 里的外部产品（它们的消息进收件箱）。',
    parameters: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: '要做什么：交付物 + 验收 + 边界。写得像给同事的任务单' },
        targets: { type: 'array', items: { type: 'string' }, description: '成员名（可多个，会同时被唤醒）' },
        group: { type: 'string', description: '（可选）群标题或 id' },
      },
      required: ['brief', 'targets'],
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(args: any, exec: any) {
      const bus = await deps.busForCaller(exec, args?.group)
      const me = await deps.identityOfCaller(exec, bus)
      const targets = asTextList(args?.targets)
      const result = await bus.assign(asText(args?.brief), targets, { from: me.name })
      const lines = [
        `任务 ${result.task.id} 已派出（状态 ${result.task.status}）。`,
        Object.entries(result.task.deliveries).map(([who, detail]) => `→ ${who}：${detail}`).join('\n'),
        '回执会出现在群里；齐了会叫醒你收尾。',
      ]
      return asResult(lines.filter((line) => line !== '').join('\n'))
    },
  })

  register({
    name: 'pipeline_report',
    description:
      '交**回执**：把「做完了什么 / 证据 / 结论 / 阻塞」写成一段话交回群里。不指定 taskId 时挂到最近一条还没收齐的任务。' +
      '回执会唤醒派活人；所有目标都交齐会自动叫醒派活人收尾。写结论与可核对的事实，不要写过程流水账。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '回执正文：做了什么、证据（命令/文件/行号）、结论、没做到的与原因' },
        taskId: { type: 'string', description: '（可选）对应任务号；省略则挂到最近未收齐的任务' },
        silent: { type: 'boolean', description: '（可选）true = 只入群不唤醒' },
        group: { type: 'string', description: '（可选）群标题或 id' },
      },
      required: ['text'],
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(args: any, exec: any) {
      const bus = await deps.busForCaller(exec, args?.group)
      const me = await deps.identityOfCaller(exec, bus)
      const taskId = asText(args?.taskId).trim()
      const result = await bus.report(asText(args?.text), {
        from: me.name,
        ...(taskId === '' ? {} : { taskId }),
        silent: args?.silent === true,
      })
      const head = result.task === undefined ? '已交回群里。' : `已挂到任务 ${result.task.id}（状态 ${result.task.status}）。`
      const woke = result.woke.length === 0 ? '' : `\n唤醒：${result.woke.join('、')}`
      return asResult(`${head}${woke}`)
    },
  })

  register({
    name: 'pipeline_members',
    description:
      '列出群成员（头像、名字、id、角色、在不在线、属于哪个项目）以及**可加入的候选会话**（宿主里所有项目）。' +
      '每个成员都有稳定 id（默认等于会话名），@ 名字或 id 都能寻址。' +
      '派活或 @ 人之前先看这里，不要臆造名单外的人。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '（可选）群标题或 id' },
        candidates: { type: 'boolean', description: '（可选）true = 同时列出还没加入的候选会话' },
      },
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render: renderResult },
    async execute(args: any, exec: any) {
      const bus = await deps.busForCaller(exec, args?.group)
      const { group, members, candidates } = await bus.members()
      const lines = [`群：${group.title}（${group.id}）`, `组长：${group.leadName}`, '', '群成员：', roster(members)]
      if (args?.candidates === true) {
        const pending = candidates.filter((candidate) => !candidate.added).slice(0, 40)
        lines.push('', `可加入的候选会话（共 ${pending.length} 个）：`)
        lines.push(
          pending
            .map(
              (candidate: Candidate) =>
                `- ${candidate.avatar?.glyph ?? '?'} ${candidate.name}  [id: ${candidate.id}]（${candidate.project ?? '?'}·${candidate.status}）`,
            )
            .join('\n'),
        )
      }
      return asResult(lines.join('\n'))
    },
  })

  return disposers
}
