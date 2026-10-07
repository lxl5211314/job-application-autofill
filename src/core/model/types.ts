// T006: 实体类型（data-model.md §1-§6）
// 注：Record<...> 使用 Partial 语义——缺键 = 资料库缺失（FR-015）

export type FieldState = "confirmed" | "needs_review"

/** "llm_rewrite" 为 v1.1 预留，第一版不会产生（spec FR-028） */
export type FieldSource = "manual" | "resume" | "llm_rewrite"

export interface ProfileField {
  value: string
  state: FieldState
  source: FieldSource
  updatedAt: number
}

export const BASIC_FIELD_IDS = [
  "basic.name",
  // T063：校招页「个人信息」区的常客（性别/出生日期），不在原 10 字段里导致整块静默
  "basic.gender",
  "basic.birthday",
  "basic.phone",
  "basic.email",
  "basic.school",
  "basic.major",
  "basic.degree",
  "basic.political_status"
] as const

export const INTENT_FIELD_IDS = [
  "intent.position",
  "intent.city",
  "intent.salary"
] as const

export type BasicFieldId = (typeof BASIC_FIELD_IDS)[number]
export type IntentFieldId = (typeof INTENT_FIELD_IDS)[number]
export type ScalarFieldId = BasicFieldId | IntentFieldId

export const ALL_SCALAR_FIELD_IDS: ScalarFieldId[] = [
  ...BASIC_FIELD_IDS,
  ...INTENT_FIELD_IDS
]

export interface Profile {
  schemaVersion: 1
  basics: Partial<Record<BasicFieldId, ProfileField>>
  intent: Partial<Record<IntentFieldId, ProfileField>>
}

export function emptyProfile(): Profile {
  return { schemaVersion: 1, basics: {}, intent: {} }
}

/** 资料库是否为空（FR-015 / NO_PROFILE 判定）：无任何 confirmed 字段即视为空 */
export function isProfileEmpty(profile: Profile): boolean {
  return (
    !Object.values(profile.basics).some((f) => f && f.value.trim() !== "") &&
    !Object.values(profile.intent).some((f) => f && f.value.trim() !== "")
  )
}

/** 按 ScalarFieldId 读取字段（跨 basics/intent 的类型安全访问） */
export function getScalarField(
  profile: Profile,
  id: ScalarFieldId
): ProfileField | undefined {
  return id.startsWith("basic.")
    ? profile.basics[id as BasicFieldId]
    : profile.intent[id as IntentFieldId]
}

/** 按 ScalarFieldId 写入字段（跨 basics/intent 的类型安全访问） */
export function setScalarField(profile: Profile, id: ScalarFieldId, field: ProfileField): void {
  if (id.startsWith("basic.")) profile.basics[id as BasicFieldId] = field
  else profile.intent[id as IntentFieldId] = field
}

export type EntryKind = "education" | "internship" | "project" | "award"

export const ENTRY_KINDS: EntryKind[] = [
  "education",
  "internship",
  "project",
  "award"
]

export interface ExperienceEntry {
  id: string
  kind: EntryKind
  order: number
  title: string
  subtitle?: string
  start?: string
  end?: string
  description?: string
  state: FieldState
  source: FieldSource
  updatedAt: number
}

export interface FieldMemory {
  signature: string
  semanticFieldId: string
  ambiguous: boolean
  value: string
  valueKind: "text" | "option"
  source: "user_confirm" | "user_edit"
  useCount: number
  lastUsedAt: number
  createdAt: number
}

export type MemoryWriteItem = Pick<
  FieldMemory,
  "signature" | "semanticFieldId" | "ambiguous" | "value" | "valueKind" | "source"
>

export type FillItemStatus =
  | "filled"
  | "needs_confirm"
  | "not_found"
  | "missing_in_profile"
  | "manual_required"

export interface FillReportItem {
  semanticFieldId: string | null
  label: string
  status: FillItemStatus
  value?: string
  reason?: string
}

export interface FillReport {
  id: string
  hostname: string
  url: string
  createdAt: number
  usedLlm: boolean
  items: FillReportItem[]
}

export interface DraftField {
  value: string
  confidence: "high" | "low"
  extracted: boolean
  /** 用户在草稿核对页手动改过（FR-007：编辑过 → confirmed） */
  edited?: boolean
}

export interface ResumeDraft {
  id: string
  fileName: string
  createdAt: number
  status: "pending" | "confirmed" | "discarded"
  fields: Partial<Record<ScalarFieldId, DraftField>>
  entries: ExperienceEntry[]
  importMode?: "overwrite" | "merge"
}

export interface Settings {
  // 以下 llm* 字段为 v1.1 预留（spec FR-028：第一版不含 AI/LLM），第一版不建 UI、不读写
  llmEnabled: boolean
  llmProvider: "openai" | "deepseek" | "anthropic" | "moonshot" | "zhipu" | null
  llmModel: string
  llmApiKey: string
  llmRewriteEnabled: boolean
}

export function defaultSettings(): Settings {
  return {
    llmEnabled: false,
    llmProvider: null,
    llmModel: "",
    llmApiKey: "",
    llmRewriteEnabled: false
  }
}

export const CURRENT_SCHEMA_VERSION = 1
