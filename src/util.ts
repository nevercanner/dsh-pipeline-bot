/**
 * 宿主服务访问工具。cordis 的 ctx 有两种取法（ctx.get / ctx.name），
 * 未 inject 时属性访问会 throw；这里统一成「先 get 再属性，失败 undefined」，
 * 任何可选服务缺席都不让整个插件 park 掉。
 */

export function resolveService<T = any>(ctx: any, name: string): T | undefined {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined) return viaGet as T
  } catch {
    /* 落到属性访问 */
  }
  try {
    const viaProperty = ctx[name]
    return (viaProperty as T) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 路径归一 + 子树判断（大小写不敏感，Windows 友）。
 * 用分隔符边界，避免 `D:\foo` 误匹配 `D:\foobar`。
 */
export function normalizePath(value: string): string {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function isWithin(parent: string, child: string): boolean {
  const p = normalizePath(parent).toLowerCase()
  const c = normalizePath(child).toLowerCase()
  if (p === '') return false
  if (c === p) return true
  return c.startsWith(`${p}/`)
}

/** 在候选根里取**最具体**（最长）地包含 child 的那个 —— 支持嵌套项目。 */
export function nearestRoot(candidates: readonly string[], child: string): string | undefined {
  let best: string | undefined
  let bestLen = -1
  for (const candidate of candidates) {
    if (!isWithin(candidate, child)) continue
    const len = normalizePath(candidate).length
    if (len > bestLen) {
      best = candidate
      bestLen = len
    }
  }
  return best
}

/** 项目名 = 目录名。 */
export function baseName(path: string): string {
  const normalized = normalizePath(path)
  const parts = normalized.split('/').filter(Boolean)
  return parts.length === 0 ? normalized : parts[parts.length - 1]!
}

/**
 * 稳定短 id：对字符串做 FNV-1a 32 位，产出 8 位 hex。
 * 群 id 用它从项目根推导 —— 同一项目永远是同一个群，跨重启不漂移。
 */
export function stableId(input: string): string {
  let hash = 0x811c9dc5
  const text = normalizePath(input).toLowerCase()
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 随机 id（消息 / 任务）。 */
export function shortRandom(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 外部输入转文本 —— **永不抛 TypeError**。
 *
 * 踩过的坑：工具参数由模型生成，`group` / `text` / `targets` 完全可能是对象或数组。
 * 早先 `(ref ?? '').trim()` 直接抛 `(ref ?? "").trim is not a function`，
 * 表现成「工具坏了」，其实是参数校验缺失。任何来自模型/HTTP 的值都先过这里。
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    // 数组按行拼：模型偶发把 text 写成字符串数组，直接接住比报错有用
    return value.map((item) => asText(item)).filter((item) => item !== '').join('\n')
  }
  if (value !== null && typeof value === 'object') {
    // 对象不是合法正文；给出可读的 JSON 让调用方自己看见问题，而不是 TypeError
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

/** 名字列表：接受数组/字符串/其它，逐项转文本并去空。 */
export function asTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asText(item).trim()).filter((item) => item !== '')
  }
  const single = asText(value).trim()
  return single === '' ? [] : [single]
}

/** 稳定的成员 id：默认 = 名字；非法字符替换成 -，保证可寻址、可用于 @ 与 DOM key。 */
export function memberIdOf(name: string): string {
  const text = asText(name).trim()
  if (text === '') return 'member'
  return text
    .replace(/[\s@＠]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5.-]/g, '')
    .slice(0, 32) || 'member'
}

/** 头像色板（彼此区分度够、在深/浅色底上都能看清）。 */
const AVATAR_COLORS = ['#5b8cff', '#2f9e6b', '#c96a2f', '#8a5cf6', '#c94a7c', '#2f9fb3', '#a07a2c', '#6b7a8f']

/** 由 id 稳定推导颜色：同一个成员每次、每台机器都是同一个颜色。 */
export function colorOf(id: string): string {
  let hash = 0x811c9dc5
  const text = asText(id)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!
}

/** 头像上的字：中文取前 1 字，英文取首字母大写；保证一眼能认出是谁。 */
export function initialsOf(name: string): string {
  const text = asText(name).trim()
  if (text === '') return '?'
  const first = [...text][0] ?? '?'
  // 中文/日文等直接取首字；拉丁字母大写
  return /[a-zA-Z]/.test(first) ? first.toUpperCase() : first
}

/** 成员头像：优先显式 emoji/图片，否则用首字 + 稳定颜色。 */
export interface Avatar {
  /** 显式 emoji（成员自己配的）或首字。 */
  glyph: string
  color: string
  /** 显式图片 URL（可选）。 */
  image?: string
}

export function avatarOf(id: string, name: string, explicit?: { glyph?: string; image?: string }): Avatar {
  const color = colorOf(id)
  if (explicit?.image !== undefined && explicit.image !== '') return { glyph: initialsOf(name), color, image: explicit.image }
  if (explicit?.glyph !== undefined && explicit.glyph.trim() !== '') return { glyph: explicit.glyph.trim().slice(0, 4), color }
  return { glyph: initialsOf(name), color }
}
