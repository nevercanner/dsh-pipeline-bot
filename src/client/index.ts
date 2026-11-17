/**
 * @dsh-external/dsh-pipeline-bot —— Client 半（浏览器侧）。
 *
 * 挂两个公开 slot：
 *   sidebar.panellist  左侧栏图标（群聊入口）
 *   main               点图标后的整页：群聊面板
 *
 * 面板要做的事：
 *   · 群切换（群是全局实体，可以有好几个）
 *   · 成员列表（含外部产品标记）
 *   · 「添加成员」：从**候选池**里挑（宿主里所有项目的会话 + 手填 sessionId + 外部产品）
 *   · 消息流 + 输入框（不 @ 交给组长，@ 谁就唤醒谁）
 *   · 外部产品接入命令（WorkBuddy / Mavis / 任意）
 *
 * ⚠️ 两个实测坑：
 *   ① inject 只能写一定存在的服务（slots）；写 layout 会让缺它的宿主 park 整个包。
 *   ② 这是**经典脚本**（window.__ModuleLoader__.load），产物里不能有 ESM 关键字 ——
 *      源码顶层的 `export const inject` 由构建脚本剥掉（见 scripts/build.mjs）。
 */
export const inject = ['slots']

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-pipeline-bot',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = '@dsh-external/dsh-pipeline-bot'
    const API = '/plugins/dsh-pipeline-bot'

    /** 群聊图标：两个叠着的对话气泡。 */
    function GroupIcon(props) {
      const size = props?.size ?? 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M2.6 4.4h8.2a1.4 1.4 0 0 1 1.4 1.4v3.8a1.4 1.4 0 0 1-1.4 1.4H5.6L3 13.4V5.8a1.4 1.4 0 0 1 1.4-1.4Z' }),
        h('path', { d: 'M14.2 7.6h2.2A1 1 0 0 1 17.4 8.6v3.2a1 1 0 0 1-1 1h-1.2L13.4 14.4v-1.6' }),
        h('circle', { cx: 5.4, cy: 7.7, r: 0.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 8.2, cy: 7.7, r: 0.7, fill: 'currentColor', stroke: 'none' }),
      )
    }

    async function getJson(path) {
      const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
      return response.json()
    }
    async function postJson(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const json = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(json?.error?.message ?? `${response.status}`)
      return json
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
      header: {
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      title: { fontWeight: 600, fontSize: 14 },
      sub: { fontSize: 12, opacity: 0.65 },
      select: {
        fontSize: 12,
        padding: '3px 6px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        maxWidth: 200,
      },
      btn: {
        padding: '3px 10px',
        borderRadius: 7,
        fontSize: 12,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,.12))',
        color: 'inherit',
      },
      chips: {
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
        padding: '8px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.18))',
        alignItems: 'center',
      },
      chip: {
        fontSize: 12,
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
      },
      dot: { width: 7, height: 7, borderRadius: 999, display: 'inline-block' },
      idTag: { fontSize: 10, opacity: 0.55, fontFamily: 'monospace' },
      flow: { flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 },
      row: { display: 'flex', flexDirection: 'column', gap: 3, maxWidth: '86%' },
      meta: { fontSize: 11, opacity: 0.6 },
      bubble: {
        padding: '7px 10px',
        borderRadius: 10,
        fontSize: 13,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,.10))',
      },
      composer: { display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))' },
      input: {
        flex: 1,
        resize: 'none',
        minHeight: 38,
        maxHeight: 140,
        padding: '8px 10px',
        borderRadius: 8,
        fontSize: 13,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
      },
      hint: { fontSize: 12, opacity: 0.6, padding: '6px 14px' },
      panel: {
        fontSize: 11,
        lineHeight: 1.5,
        padding: '8px 14px',
        borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.2))',
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,.05))',
        maxHeight: 220,
        overflowY: 'auto',
      },
      code: {
        display: 'block',
        fontFamily: 'monospace',
        fontSize: 10.5,
        padding: '6px 8px',
        borderRadius: 6,
        background: 'rgba(128,128,128,.12)',
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
      cell: { padding: '2px 4px', borderBottom: '1px solid rgba(128,128,128,.15)' },
    }

    const ROLE_COLOR = { lead: '#7c5cff', member: '#2f9e6b', human: '#2f6fdd', system: '#999', external: '#8a5cf6' }

    /** 成员头像：有图片用图片，否则用首字 + 稳定颜色（同一个成员永远同一个样子）。 */
    function Avatar(props) {
      const { member, size = 18 } = props
      const avatar = member?.avatar ?? { glyph: (member?.name ?? '?').slice(0, 1), color: '#6b7a8f' }
      const base = {
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.55),
        lineHeight: 1,
        color: '#fff',
        background: avatar.color,
        flex: '0 0 auto',
        fontWeight: 600,
        overflow: 'hidden',
      }
      if (avatar.image) {
        return h('img', { src: avatar.image, alt: member.name, style: { ...base, objectFit: 'cover' } })
      }
      return h('span', { style: base, title: `${member.name}（id: ${member.id}）` }, avatar.glyph)
    }

    function MemberChip(props) {
      const { member } = props
      const color =
        member.role === 'external' ? '#8a5cf6' : member.status === 'live' ? '#2f9e6b' : member.status === 'inactive' ? '#c99a2e' : '#999'
      const tag =
        member.role === 'lead'
          ? ' · 组长'
          : member.role === 'external'
            ? ` · ${member.product ?? '外部'}`
            : member.project
              ? ` · ${member.project}`
              : ''
      return h(
        'span',
        {
          style: S.chip,
          title: `id: ${member.id}${member.sessionId ? `
会话: ${member.sessionId}` : ''}${member.duty ? `
职责: ${member.duty}` : ''}`,
        },
        h(Avatar, { member, size: 16 }),
        member.name,
        h('code', { style: S.idTag }, member.id),
        tag,
      )
    }

    function MessageRow(props) {
      const { message, members } = props
      const author =
        (members ?? []).find((member) => member.id !== undefined && member.id === message.fromId) ??
        (members ?? []).find((member) => member.name === message.from)
      const isSystem = message.role === 'system'
      const isHuman = message.role === 'human'
      const color = ROLE_COLOR[message.role] ?? '#888'
      return h(
        'div',
        { style: { ...S.row, alignSelf: isHuman ? 'flex-end' : 'flex-start' } },
        h(
          'div',
          { style: { ...S.meta, color, display: 'flex', alignItems: 'center', gap: 5 } },
          author ? h(Avatar, { member: author, size: 14 }) : null,
          `${message.from}${author?.id ? ` · ${author.id}` : ''}${message.targets?.length ? ` → ${message.targets.join('、')}` : ''} · ${new Date(message.ts).toLocaleTimeString()}`,
        ),
        h(
          'div',
          {
            style: {
              ...S.bubble,
              ...(isSystem ? { opacity: 0.7, fontFamily: 'monospace', fontSize: 11 } : {}),
              ...(isHuman ? { background: 'var(--dsw-alias-bg-accent, rgba(47,111,221,.16))' } : {}),
            },
          },
          message.text,
        ),
      )
    }

    function Panel() {
      const [state, setState] = React.useState({ loading: true, error: '', snap: null })
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [groupRef, setGroupRef] = React.useState('')
      const [tab, setTab] = React.useState('chat')
      const [newMember, setNewMember] = React.useState({ name: '', sessionId: '', product: '', duty: '', glyph: '' })
      const [newGroup, setNewGroup] = React.useState('')
      const [projects, setProjects] = React.useState([])
      const [newGroupProject, setNewGroupProject] = React.useState('')
      const flowRef = React.useRef(null)

      const load = React.useCallback(async (ref) => {
        try {
          const query = ref === '' ? '' : `?group=${encodeURIComponent(ref)}`
          const snap = await getJson(`/group${query}`)
          setState({ loading: false, error: '', snap })
          return snap
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, error: String(error?.message ?? error) }))
          return undefined
        }
      }, [])

      React.useEffect(() => {
        void load('')
        void (async () => {
          try {
            const result = await getJson('/projects')
            setProjects(result.projects ?? [])
          } catch {
            setProjects([])
          }
        })()
      }, [load])

      React.useEffect(() => {
        if (state.snap === null) return undefined
        const timer = setInterval(() => void load(groupRef), 4000)
        return () => clearInterval(timer)
      }, [groupRef, state.snap === null, load])

      const messages = state.snap?.group?.messages ?? []
      React.useEffect(() => {
        const el = flowRef.current
        if (el !== null) el.scrollTop = el.scrollHeight
      }, [messages.length])

      const act = async (fn) => {
        setBusy(true)
        try {
          await fn()
          await load(groupRef)
        } catch (error) {
          setState((prev) => ({ ...prev, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }

      const send = () =>
        act(async () => {
          const text = draft.trim()
          if (text === '') return
          await postJson('/say', { group: groupRef, text })
          setDraft('')
        })

      const snap = state.snap
      const groups = snap?.groups ?? []
      const members = snap?.members ?? []
      const candidates = (snap?.candidates ?? []).filter((candidate) => !candidate.added).slice(0, 60)

      const addFromCandidate = (candidate) =>
        act(async () => {
          await postJson('/member', { group: groupRef, name: candidate.name, sessionId: candidate.sessionId })
        })

      const addManual = () =>
        act(async () => {
          const payload = { group: groupRef, name: newMember.name.trim() }
          if (newMember.sessionId.trim() !== '') payload.sessionId = newMember.sessionId.trim()
          if (newMember.product.trim() !== '') payload.product = newMember.product.trim()
          if (newMember.duty.trim() !== '') payload.duty = newMember.duty.trim()
          if (newMember.glyph.trim() !== '') payload.glyph = newMember.glyph.trim()
          if (payload.name === '') throw new Error('成员需要名字')
          await postJson('/member', payload)
          setNewMember({ name: '', sessionId: '', product: '', duty: '', glyph: '' })
        })

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.header },
          h('span', { style: S.title }, `群聊 · ${snap?.group?.title ?? '…'}`),
          h(
            'select',
            {
              style: S.select,
              value: groupRef,
              onChange: (event) => {
                setGroupRef(event.target.value)
                void load(event.target.value)
              },
            },
            h('option', { value: '' }, `（当前：${snap?.group?.title ?? '默认群'}）`),
            groups.map((group) => h('option', { key: group.id, value: group.id }, `${group.title}（${group.memberCount}人）`)),
          ),
          h('span', { style: S.sub }, `${members.length} 人 · ${messages.length} 条`),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              style: S.btn,
              onClick: () =>
                act(async () => {
                  if (newGroup.trim() === '') return
                  const created = await postJson('/groups', {
                    title: newGroup.trim(),
                    ...(newGroupProject === '' ? {} : { projectRoot: newGroupProject }),
                  })
                  setNewGroup('')
                  setGroupRef(created.group.id)
                  await load(created.group.id)
                }),
            },
            '新建群',
          ),
          h('input', {
            style: { ...S.select, width: 110 },
            placeholder: '群名',
            value: newGroup,
            onChange: (event) => setNewGroup(event.target.value),
          }),
          h(
            'select',
            {
              style: S.select,
              value: newGroupProject,
              title: '群聊会话落在哪个已有项目里（不会新建项目）',
              onChange: (event) => setNewGroupProject(event.target.value),
            },
            h('option', { value: '' }, '项目（默认当前）'),
            projects.map((project) => h('option', { key: project.id, value: project.path }, project.title)),
          ),
        ),
        h(
          'div',
          { style: S.chips },
          members.map((member) => h(MemberChip, { key: member.sessionId || member.name, member })),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.btn, onClick: () => setTab(tab === 'manage' ? 'chat' : 'manage') }, tab === 'manage' ? '回到聊天' : '管理成员'),
        ),
        tab === 'chat'
          ? h(
              'div',
              { ref: flowRef, style: S.flow },
              messages.length === 0
                ? h('div', { style: S.hint }, '还没有消息。不 @ 交给组长；@成员名 会直接唤醒对方（可跨项目）。')
                : messages.map((message) => h(MessageRow, { key: message.id, message, members })),
            )
          : h(
              'div',
              { style: { ...S.flow, gap: 10 } },
              h('div', { style: { fontWeight: 600 } }, '可加入的会话（宿主里所有项目）'),
              candidates.length === 0
                ? h('div', { style: S.hint }, '没有候选了：宿主里的会话都已加入。')
                : h(
                    'table',
                    { style: S.table },
                    h(
                      'thead',
                      null,
                      h('tr', null, ['', '名字', 'id', '项目', '状态', ''].map((label) => h('th', { key: label, style: S.cell }, label))),
                    ),
                    h(
                      'tbody',
                      null,
                      candidates.map((candidate) =>
                        h(
                          'tr',
                          { key: candidate.sessionId },
                          h('td', { style: S.cell }, h(Avatar, { member: candidate, size: 16 })),
                          h('td', { style: S.cell }, candidate.name),
                          h('td', { style: S.cell }, h('code', { style: S.idTag }, candidate.id ?? candidate.name)),
                          h('td', { style: S.cell }, candidate.project ?? '?'),
                          h('td', { style: S.cell }, candidate.status === 'live' ? '醒着' : '离线'),
                          h(
                            'td',
                            { style: S.cell },
                            h('button', { style: S.btn, onClick: () => void addFromCandidate(candidate) }, '加入'),
                          ),
                        ),
                      ),
                    ),
                  ),
              h('div', { style: { fontWeight: 600, marginTop: 6 } }, '手填成员（外部产品或指定会话）'),
              h(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h('input', { style: { ...S.select, width: 120 }, placeholder: '名字（@用）', value: newMember.name, onChange: (e) => setNewMember({ ...newMember, name: e.target.value }) }),
                h('input', { style: { ...S.select, width: 220 }, placeholder: 'sessionId（外部产品留空）', value: newMember.sessionId, onChange: (e) => setNewMember({ ...newMember, sessionId: e.target.value }) }),
                h('input', { style: { ...S.select, width: 110 }, placeholder: '产品名如 Mavis', value: newMember.product, onChange: (e) => setNewMember({ ...newMember, product: e.target.value }) }),
                h('input', { style: { ...S.select, width: 140 }, placeholder: '职责（可选）', value: newMember.duty, onChange: (e) => setNewMember({ ...newMember, duty: e.target.value }) }),
                h('input', { style: { ...S.select, width: 84 }, placeholder: '头像 emoji', value: newMember.glyph, onChange: (e) => setNewMember({ ...newMember, glyph: e.target.value }) }),
                h('button', { style: S.btn, onClick: () => void addManual() }, '加入群'),
              ),
              h('div', { style: { fontWeight: 600, marginTop: 6 } }, '移除成员'),
              h(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                members
                  .filter((member) => member.role !== 'lead')
                  .map((member) =>
                    h(
                      'button',
                      {
                        key: member.sessionId || member.name,
                        style: S.btn,
                        onClick: () => act(async () => { await postJson('/member', { group: groupRef, action: 'remove', name: member.name }) }),
                      },
                      `移除 ${member.name}`,
                    ),
                  ),
              ),
            ),
        state.error !== '' ? h('div', { style: { ...S.hint, color: '#d05a5a' } }, state.error) : null,
        h(
          'div',
          { style: S.composer },
          h('textarea', {
            style: S.input,
            value: draft,
            placeholder: '在群里说话…（@chapter 交给你 / 不 @ 交给组长）',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            },
          }),
          h('button', { style: S.btn, disabled: busy, onClick: () => void send() }, busy ? '…' : '发送'),
        ),
        h('div', { style: S.hint }, 'Enter 发送，Shift+Enter 换行。每条消息唤醒所有被 @ 的成员（各自独立上下文干活，可跨项目）。'),
        snap?.bridgeKey
          ? h(
              'div',
              { style: S.panel },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '接入外部 agent 产品（WorkBuddy / Mavis / 任意产品）'),
              h('div', { style: { opacity: 0.75, marginBottom: 4 } }, '产品侧跑这一行即可加入本群，出现在成员列表并能收发消息：'),
              h(
                'code',
                { style: S.code },
                `node <插件目录>/bin/client.mjs --base <本机地址> --project "${snap.group?.id ?? ''}" --member workbuddy --product WorkBuddy --key ${snap.bridgeKey} --reply-cmd "<你的产品命令行>"`,
              ),
              h(
                'div',
                { style: { opacity: 0.6, marginTop: 4 } },
                `群聊会话：${snap.roomSessionId || '（未创建）'} · 落在项目：${snap.group?.projectRoot || '（未指定）'}`,
              ),
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx?.slots
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

        ctx.effect(
          () =>
            slots.inject('sidebar.panellist', () =>
              slots.register({ name: 'sidebar.panellist', id: NS, order: 12, label: '群聊' }, (props) =>
                h(GroupIcon, { size: props?.size ?? 18 }),
              ),
            ),
          'pipeline-bot: panellist',
        )
        ctx.effect(
          () => slots.inject('main', () => slots.register({ name: 'main', key: NS }, () => h(Panel, null))),
          'pipeline-bot: main',
        )
      },
    }
  },
})
