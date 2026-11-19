/**
 * 公共类型。
 *
 * ── 核心模型（按「群是一等实体」设计）──────────────────────────
 * `Group` 不是「某个项目」的派生物。它是一个独立存在的群：
 *   · 有自己的 id、标题、组长
 *   · 成员是**显式加入**的，可以来自任意项目、任意 DSH 会话、任意外部产品
 *   · 项目根只是成员的一个属性（显示用、以及「候选池」的来源），不是群的边界
 *
 * 这解决的问题：群聊是给人用的协作空间，不该因为「你在 A 项目干活」就
 * 看不见 B 项目的人。项目是**候选来源**，不是围墙。
 */

export type MemberRole = 'lead' | 'worker' | 'external'

/** 成员在线状态。live 可立即唤醒；inactive 有会话记录但未激活；missing 找不到会话。 */
export type MemberStatus = 'live' | 'inactive' | 'missing'

export interface Member {
  /** 群里 @ 用的名字（群里唯一）。 */
  name: string
  /**
   * 成员 id：稳定、唯一、可寻址。
   * 默认 = 会话标题（即你给会话起的名字），重名时自动加后缀。
   */
  id: string
  /** 头像：显式 emoji/图片，或由 id 稳定推导的首字 + 颜色。 */
  avatar: { glyph: string; color: string; image?: string }
  /** DSH 会话 id；外部产品为空。 */
  sessionId: string
  role: MemberRole
  status: MemberStatus
  /** 该会话所属项目根（展示与「候选池」用，不构成群的边界）。 */
  cwd?: string
  /** 项目名（目录名），展示用。 */
  project?: string
  /** 一句话职责，写进唤醒正文，帮助决定谁干什么。 */
  duty?: string
  /** 外部产品名（WorkBuddy / Mavis / 任意）。 */
  product?: string
  /** 最近活跃时间（ms）。 */
  seenAt?: number
  /** 外部产品最近一次 poll/post 时间。 */
  lastSeen?: number
}

/** 群成员登记（持久化形态：只记「谁在群里」，状态每次现算）。 */
export interface MemberRecord {
  name: string
  /** 成员 id（默认 = name；加入时定下来，改名不改 id）。 */
  id?: string
  /** 显式头像（emoji）；不填则用首字 + 稳定颜色。 */
  glyph?: string
  /** 显式头像图片 URL。 */
  image?: string
  /** DSH 会话 id；外部产品留空。 */
  sessionId?: string
  role: Exclude<MemberRole, never>
  duty?: string
  /** 外部产品名。 */
  product?: string
  /** 加入时间。 */
  addedAt: number
}

export interface Message {
  id: string
  ts: number
  /** 发言人名字；`system` 表示系统事件。 */
  from: string
  /** 发言人成员 id（有头像的一方才有值）。 */
  fromId?: string
  role: 'lead' | 'member' | 'human' | 'system' | 'external'
  text: string
  kind: 'human' | 'assign' | 'say' | 'report' | 'system' | 'wake'
  taskId?: string
  /** 本条消息唤醒的成员名。 */
  targets?: string[]
}

export interface Task {
  id: string
  createdAt: number
  updatedAt: number
  brief: string
  /** 派活人（回执齐了叫醒它收尾）。 */
  from: string
  targets: string[]
  status: 'dispatched' | 'reported' | 'failed'
  deliveries: Record<string, string>
  reports?: Record<string, string>
  report?: string
}

/** 一个群。 */
export interface Group {
  id: string
  title: string
  /** 组长名（人发言不 @ 时交给它）。 */
  leadName: string
  members: MemberRecord[]
  messages: Message[]
  tasks: Task[]
  /**
   * 群聊会话：宿主里的一个**普通真实会话**，落在 `projectRoot` 那个已有项目里，
   * 并固定在会话列表第一位（宿主 pin）。群的成员靠本记录里的 `members` 关联，
   * 与会话所在目录无关 —— 群不是项目，也不为它造目录/工作区。
   */
  roomSessionId?: string
  /**
   * 群的锚定项目（必须是宿主里**已存在**的项目目录）。
   * 只决定群聊会话落在哪个项目的会话列表里；成员仍可来自任意项目。
   */
  projectRoot?: string
  /** 外部产品桥接 key。 */
  bridgeKey: string
  /**
   * 已写进群聊会话的消息 id（去重账本）。
   *
   * 为什么按 id 而不是按内容：内容去重需要 TTL，回填重跑就会重复写；
   * 按 id 记账是幂等的 —— 同一条群消息不管回填几次，只会写一遍。
   */
  roomMirrored?: string[]
  /**
   * 群静音：true 时**不唤醒任何成员**（消息照常记录、照常入队）。
   * 用于把「成员互相唤醒」的活锁群一键停下来。
   */
  muted?: boolean
  createdAt: number
  updatedAt: number
}

/** 全量快照（面板一次拿齐）。 */
export interface GroupSnapshot {
  ok: boolean
  groups: Array<{ id: string; title: string; memberCount: number; updatedAt: number }>
  group: Group
  /** 现算状态的成员（含在线标记）。 */
  members: Member[]
  /** 候选池：宿主里所有可加入的会话（跨项目），已在群里标记 added。 */
  candidates: Candidate[]
  origin?: string
}

/** 候选成员：宿主里一个可加入群的会话。 */
export interface Candidate {
  sessionId: string
  /** 建议名字（标题 / 自注册名）。 */
  name: string
  /** 建议 id（默认取名字）。 */
  id: string
  /** 该候选的头像（由 id 推导）。 */
  avatar: { glyph: string; color: string }
  cwd?: string
  project?: string
  status: 'live' | 'inactive'
  /** 已在当前群里。 */
  added: boolean
  updatedAt?: number
}

export const DEFAULT_GROUP_TITLE = '协作群'
export const DEFAULT_LEAD_NAME = '管线维护'
