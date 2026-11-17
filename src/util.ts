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
