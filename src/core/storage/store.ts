// T008: storage 层（chrome.storage.local 统一读写 + schemaVersion 迁移 + 限额 LRU）
// 键名与 data-model.md §0 一一对应

import {
  CURRENT_SCHEMA_VERSION,
  defaultSettings,
  emptyProfile,
  type ExperienceEntry,
  type FieldMemory,
  type FillReport,
  type MemoryWriteItem,
  type Profile,
  type ResumeDraft,
  type Settings
} from "../model/types"
import { validateEntry, validateProfile } from "../model/validation"

export const MEMORY_LIMIT = 2000
export const REPORT_LIMIT = 20

const KEYS = {
  version: "schemaVersion",
  profile: "profile",
  entries: "entries",
  memory: "fieldMemory",
  reports: "fillReports",
  draft: "resumeDrafts",
  settings: "settings"
} as const

export class ValidationError extends Error {
  details: Record<string, string>
  constructor(details: Record<string, string>) {
    super("校验失败")
    this.name = "ValidationError"
    this.details = details
  }
}

function storageArea(): chrome.storage.StorageArea {
  const api = (globalThis as { chrome?: typeof chrome }).chrome
  if (!api?.storage?.local) {
    throw new Error("chrome.storage.local 不可用")
  }
  return api.storage.local
}

async function get<T>(key: string): Promise<T | undefined> {
  const record = await storageArea().get(key)
  return record[key] as T | undefined
}

async function set(items: Record<string, unknown>): Promise<void> {
  await storageArea().set(items)
}

/**
 * 迁移函数（S7 可执行）：接收原始存储快照，返回迁移后的快照。
 * v1: 缺失 schemaVersion → 补默认结构；未来版本在此追加迁移链。
 */
export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  const v = typeof out[KEYS.version] === "number" ? (out[KEYS.version] as number) : 0
  if (v < 1) {
    // v0 → v1：历史上若有裸键数据，包一层；此处仅补默认值
    if (!out[KEYS.profile]) out[KEYS.profile] = emptyProfile()
    if (!out[KEYS.entries]) out[KEYS.entries] = []
    if (!out[KEYS.memory]) out[KEYS.memory] = []
    if (!out[KEYS.reports]) out[KEYS.reports] = []
    if (!out[KEYS.settings]) out[KEYS.settings] = defaultSettings()
    out[KEYS.version] = 1
  }
  return out
}

/** 确保存储结构存在（幂等） */
export async function ensureSchema(): Promise<void> {
  const version = await get<number>(KEYS.version)
  if (version === CURRENT_SCHEMA_VERSION) return
  const snapshot = (await storageArea().get(null)) as Record<string, unknown>
  const migrated = migrate(snapshot)
  await set(migrated)
}

// ---------- Profile / Entries ----------

export async function getProfile(): Promise<Profile> {
  await ensureSchema()
  const p = await get<Profile>(KEYS.profile)
  if (!p || typeof p !== "object") return emptyProfile()
  return { ...emptyProfile(), ...p }
}

export async function getEntries(): Promise<ExperienceEntry[]> {
  await ensureSchema()
  return (await get<ExperienceEntry[]>(KEYS.entries)) ?? []
}

export async function saveProfile(profile: Profile): Promise<void> {
  const errors = validateProfile(profile)
  if (Object.keys(errors).length > 0) throw new ValidationError(errors)
  await set({ [KEYS.profile]: profile })
}

export async function saveEntries(entries: ExperienceEntry[]): Promise<void> {
  const errors: Record<string, string> = {}
  for (const e of entries) Object.assign(errors, validateEntry(e))
  if (Object.keys(errors).length > 0) throw new ValidationError(errors)
  await set({ [KEYS.entries]: entries })
}

// ---------- FieldMemory（LRU ≤ 2000） ----------

export async function getAllMemory(): Promise<FieldMemory[]> {
  await ensureSchema()
  return (await get<FieldMemory[]>(KEYS.memory)) ?? []
}

/** 批量查记忆（FR-020/021）：命中即更新 useCount/lastUsedAt */
export async function memoryLookup(
  signatures: string[]
): Promise<Array<{ signature: string; memory: FieldMemory | null }>> {
  const all = await getAllMemory()
  const bySig = new Map(all.map((m) => [m.signature, m]))
  const now = Date.now()
  let touched = false

  const results = signatures.map((signature) => {
    const hit = bySig.get(signature)
    if (!hit) return { signature, memory: null }
    hit.useCount += 1
    hit.lastUsedAt = now
    touched = true
    return { signature, memory: hit }
  })

  if (touched) await set({ [KEYS.memory]: all })
  return results
}

/** 写入/更新记忆（source 仅允许 user_confirm | user_edit，FR-020/023） */
export async function memoryWrite(items: MemoryWriteItem[]): Promise<void> {
  const allowed = new Set(["user_confirm", "user_edit"])
  for (const item of items) {
    if (!allowed.has(item.source)) {
      throw new Error(`不允许的 memory source: ${item.source}`)
    }
  }
  const all = await getAllMemory()
  const bySig = new Map(all.map((m) => [m.signature, m]))
  const now = Date.now()

  for (const item of items) {
    const existing = bySig.get(item.signature)
    if (existing) {
      existing.value = item.value
      existing.valueKind = item.valueKind
      existing.semanticFieldId = item.semanticFieldId
      existing.ambiguous = item.ambiguous
      existing.source = item.source
      existing.lastUsedAt = now
    } else {
      const created: FieldMemory = {
        ...item,
        useCount: 0,
        lastUsedAt: now,
        createdAt: now
      }
      bySig.set(item.signature, created)
    }
  }

  let next = Array.from(bySig.values())
  if (next.length > MEMORY_LIMIT) {
    next.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    next = next.slice(0, MEMORY_LIMIT)
  }
  await set({ [KEYS.memory]: next })
}

// ---------- FillReport（≤ 20 条） ----------

export async function pushFillReport(report: FillReport): Promise<void> {
  const list = ((await get<FillReport[]>(KEYS.reports)) ?? []).filter(
    (r) => r.id !== report.id
  )
  list.unshift(report)
  await set({ [KEYS.reports]: list.slice(0, REPORT_LIMIT) })
}

export async function listFillReports(): Promise<FillReport[]> {
  await ensureSchema()
  return (await get<FillReport[]>(KEYS.reports)) ?? []
}

/** 更新报告中某语义字段条目的状态（confirm:resolve 后同步报告，FR-014） */
export async function updateFillReportItem(
  reportId: string,
  semanticFieldId: string,
  status: FillReport["items"][number]["status"],
  value?: string
): Promise<void> {
  const list = (await get<FillReport[]>(KEYS.reports)) ?? []
  const report = list.find((r) => r.id === reportId)
  if (!report) return
  const item = report.items.find(
    (i) => i.semanticFieldId === semanticFieldId && i.status === "needs_confirm"
  )
  if (item) {
    item.status = status
    if (value !== undefined) item.value = value
  }
  await set({ [KEYS.reports]: list })
}

// ---------- ResumeDraft（单例） ----------

export async function getResumeDraft(): Promise<ResumeDraft | null> {
  await ensureSchema()
  return (await get<ResumeDraft>(KEYS.draft)) ?? null
}

export async function setResumeDraft(draft: ResumeDraft | null): Promise<void> {
  await set({ [KEYS.draft]: draft })
}

// ---------- Settings（llm* 为 v1.1 预留，第一版仅读写结构） ----------

export async function getSettings(): Promise<Settings> {
  await ensureSchema()
  const s = await get<Settings>(KEYS.settings)
  return { ...defaultSettings(), ...(s ?? {}) }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await set({ [KEYS.settings]: settings })
}
