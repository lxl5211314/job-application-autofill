// T021: 确定性匹配器（contracts/semantic-fields.md §1-§6 置信分档）
// high = 别名精确命中且控件吻合；gray = 包含/仅 name 信号；low = 歧义或无候选

import type { ExperienceEntry, FieldMemory, Profile } from "../model/types"
import {
  AMBIGUOUS_LABELS,
  ENTRY_BLOCK_TITLES,
  ENTRY_COLUMN_ALIASES,
  SCALAR_VOCABULARY,
  findEquivalentOption,
  salaryEquivalent,
  semanticFieldLabel
} from "./vocabulary"
import { normLabel } from "./signature"
import type { EntryKind } from "../model/types"
import type { ScannedField } from "./scan"

export type Confidence = "high" | "gray" | "low"

export interface FieldMatch {
  field: ScannedField
  semanticFieldId: string | null
  confidence: Confidence
  candidates: string[]
  ambiguous: boolean
  conflict: boolean
  reason?: string
}

export type PlanAction = "fill" | "confirm" | "missing" | "manual"

export interface FillPlanItem {
  match: FieldMatch
  action: PlanAction
  reason?: string
  value?: string
  entryIndex?: number
  entryKind?: EntryKind
}

export interface FillPlan {
  items: FillPlanItem[]
  notFound: string[]
}

// 词表排除：这些词命中时不归类（联系人/收货/紧急联系人等，FR-017 边界）
const LABEL_EXCLUSIONS = [/联系人/, /收货/, /紧急/, /直系亲属/, /非本人/, /备用联系/]

function excluded(label: string): boolean {
  return LABEL_EXCLUSIONS.some((p) => p.test(label))
}

function ambiguousLabel(label: string): boolean {
  const n = normLabel(label)
  return AMBIGUOUS_LABELS.some((a) => normLabel(a) === n)
}

/** 经历区块判定：blockTitle 命中某类经历标题 */
function entryKindOf(field: ScannedField): EntryKind | null {
  const block = normLabel(field.blockTitle)
  if (!block) return null
  for (const [kind, titles] of Object.entries(ENTRY_BLOCK_TITLES)) {
    if (titles.some((t) => normLabel(t) === block || block.includes(normLabel(t)))) {
      return kind as EntryKind
    }
  }
  return null
}

function matchEntryColumn(field: ScannedField, kind: EntryKind): string | null {
  // 列标题优先（表格），其次区块内标签
  const signals = [field.columnLabel, field.labelText].filter((s) => s !== "")
  for (const [suffix, def] of Object.entries(ENTRY_COLUMN_ALIASES)) {
    const aliases = [...def.zh, ...def.en].map(normLabel)
    for (const sig of signals) {
      const n = normLabel(sig)
      if (aliases.includes(n)) return `entry.${kind}.${suffix}`
      if (n.length >= 2 && aliases.some((a) => a.length >= 2 && n.includes(a))) {
        return `entry.${kind}.${suffix}`
      }
    }
  }
  return null
}

interface Candidate {
  id: string
  score: number
  exact: boolean
  viaLabel: boolean
}

function scalarCandidates(field: ScannedField): Candidate[] {
  const label = field.labelText
  const nameId = normLabel(field.nameIdPlaceholder)
  const labelStripped = normLabel(label.replace(/[\s*必填]+$/g, ""))
  const out: Candidate[] = []

  if (label && !excluded(label)) {
    for (const vocab of SCALAR_VOCABULARY) {
      const aliases = [...vocab.zh, ...vocab.en].map(normLabel)
      let score = 0
      let exact = false
      if (aliases.includes(labelStripped)) {
        score = 100
        exact = true
      } else if (labelStripped.length >= 2) {
        const hit = aliases.filter((a) => a.length >= 2 && labelStripped.includes(a))
        if (hit.length > 0) {
          score = 60 + Math.max(...hit.map((a) => a.length)) * 3
        } else {
          const rev = aliases.filter((a) => a.length >= 2 && a.includes(labelStripped))
          if (rev.length > 0) score = 52
        }
      }
      if (score > 0) out.push({ id: vocab.id, score, exact, viaLabel: true })
    }
  }

  // 仅 name/id 信号（无 label 命中时）
  if (nameId && out.length === 0) {
    for (const vocab of SCALAR_VOCABULARY) {
      const aliases = [...vocab.zh, ...vocab.en].map(normLabel)
      if (aliases.some((a) => (a.length >= 2 && nameId.includes(a)) || nameId === a)) {
        out.push({ id: vocab.id, score: 45, exact: false, viaLabel: false })
      }
    }
  }

  // select/radio 选项集形状兜底（如 label 弱但选项全是学历值）
  if (out.length === 0 && (field.controlKind === "select" || field.controlKind === "radio")) {
    const opts = (field.optionTexts ?? []).map(normLabel)
    if (opts.length > 0) {
      if (findEquivalentOption("本科", field.optionTexts ?? [])) {
        out.push({ id: "basic.degree", score: 58, exact: false, viaLabel: false })
      }
    }
  }

  return out
}

function controlMatches(vocabId: string, kind: string): boolean {
  const vocab = SCALAR_VOCABULARY.find((v) => v.id === vocabId)
  if (!vocab) return false
  return vocab.controls.includes(kind as never)
}

export function matchField(field: ScannedField, memory?: FieldMemory | null): FieldMatch {
  const base: FieldMatch = {
    field,
    semanticFieldId: null,
    confidence: "low",
    candidates: [],
    ambiguous: false,
    conflict: false
  }

  // 记忆命中：签名一致 → 高置信直填（FR-021）；歧义记忆 → 仍进确认（FR-022）
  if (memory) {
    if (memory.ambiguous) {
      return { ...base, ambiguous: true, reason: "记忆标记为歧义（FR-022）" }
    }
    if (memory.semanticFieldId && memory.semanticFieldId !== "unknown") {
      return {
        ...base,
        semanticFieldId: memory.semanticFieldId,
        confidence: "high",
        reason: "字段记忆命中（FR-021）"
      }
    }
  }

  // 黑名单控件（密码/上传/协议等）不参与匹配；只读控件（T057）除外——
  // 它需要匹配出字段名以便上报「需人工」，但永远不会被 fill
  if (field.manual && field.manual !== "readonly") return base

  const label = field.labelText
  if (label && excluded(label)) return base

  if (label && ambiguousLabel(label)) {
    return { ...base, ambiguous: true, reason: "歧义标签（FR-022）" }
  }

  // 经历区块：列标题精确 → entry.<kind>.<suffix>（high）
  const kind = entryKindOf(field)
  if (kind) {
    const entryId = matchEntryColumn(field, kind)
    if (entryId) {
      const suffix = entryId.split(".")[2] ?? ""
      const def = ENTRY_COLUMN_ALIASES[suffix]
      const controlOk = def ? def.controls.includes(field.controlKind as never) : false
      return {
        ...base,
        semanticFieldId: entryId,
        confidence: controlOk ? "high" : "gray",
        reason: `经历区块列命中（${field.blockTitle}）`
      }
    }
  }

  const cands = scalarCandidates(field)
  if (cands.length === 0) return base

  cands.sort((a, b) => b.score - a.score)
  const top = cands[0] as Candidate
  const tied = cands.filter((c) => c.score === top.score)

  if (tied.length > 1 && top.exact) {
    return {
      ...base,
      confidence: "gray",
      candidates: tied.map((c) => c.id),
      ambiguous: true,
      reason: "多个候选别名命中"
    }
  }

  const id = top.id
  const candidates = cands.map((c) => c.id)

  if (top.exact) {
    const controlOk = controlMatches(id, field.controlKind)
    if (controlOk) {
      return { ...base, semanticFieldId: id, confidence: "high", candidates }
    }
    return {
      ...base,
      semanticFieldId: id,
      confidence: "gray",
      candidates,
      reason: "别名命中但控件类型不吻合"
    }
  }

  if (top.score >= 60) {
    return { ...base, semanticFieldId: id, confidence: "gray", candidates, reason: "别名部分包含命中" }
  }

  // 仅 name/id 信号（45 分）→ gray
  return { ...base, semanticFieldId: id, confidence: "gray", candidates, reason: "仅 name/id 信号命中" }
}

// ---------- 填充计划（T021: FR-014/015/016/017） ----------

function profileValue(
  profile: Profile,
  id: string
): { value: string; state: string } | null {
  if (id.startsWith("basic.")) {
    const f = profile.basics[id as keyof Profile["basics"]]
    return f ? { value: f.value, state: f.state } : null
  }
  if (id.startsWith("intent.")) {
    const f = profile.intent[id as keyof Profile["intent"]]
    return f ? { value: f.value, state: f.state } : null
  }
  return null
}

function entriesOfKind(entries: ExperienceEntry[], kind: EntryKind): ExperienceEntry[] {
  return entries
    .filter((e) => e.kind === kind)
    .sort((a, b) => a.order - b.order)
}

function textEquivalent(value: string, current: string): boolean {
  const a = normLabel(value)
  const b = normLabel(current)
  if (a === b) return true
  // 电话/纯数字宽松比较
  const da = a.replace(/\D/g, "")
  const db = b.replace(/\D/g, "")
  if (da.length >= 7 && da === db) return true
  return salaryEquivalent(value, current)
}

export function currentValueOf(field: ScannedField): string {
  const el = field.element
  if (field.controlKind === "select") {
    const sel = el as HTMLSelectElement
    return sel.value === "" ? "" : (sel.selectedOptions[0]?.textContent ?? "").trim()
  }
  if (field.controlKind === "radio" && field.radioGroup) {
    const checked = field.radioGroup.find((r) => r.checked)
    return checked ? (checked.value || "") : ""
  }
  if (field.controlKind === "checkbox") {
    return (el as HTMLInputElement).checked ? "true" : ""
  }
  return ((el as HTMLInputElement).value ?? "").trim()
}

export interface PlanOptions {
  memoryBySig?: Map<string, FieldMemory>
  /** 页面预填值与目标不一致时强制覆盖（用户在面板点"覆盖"时用） */
  allowConflict?: boolean
}

export function buildFillPlan(
  scanned: ScannedField[],
  profile: Profile,
  entries: ExperienceEntry[],
  options: PlanOptions = {}
): FillPlan {
  const items: FillPlanItem[] = []
  const covered = new Set<string>()
  const memoryBySig = options.memoryBySig

  for (const field of scanned) {
    if (field.manual) {
      // T057：只读控件不填写——仅在匹配到资料字段时上报「需人工」（带字段名），
      // 匹配不上的只读控件不上报（与 FR-019 的静默过滤保持一致，避免噪音）
      if (field.manual === "readonly") {
        const roMatch = matchField(field, null)
        if (roMatch.semanticFieldId && !roMatch.ambiguous) {
          items.push({
            match: roMatch,
            action: "manual",
            reason: "只读控件（需在页面弹层中选择），不自动填写"
          })
        }
        continue
      }
      items.push({
        match: {
          field,
          semanticFieldId: null,
          confidence: "low",
          candidates: [],
          ambiguous: false,
          conflict: false,
          reason: `非填写区控件（${field.manual}）`
        },
        action: "manual",
        reason: `非填写区（${field.manual}），需人工处理`
      })
      continue
    }

    const memory = memoryBySig?.get(field.signature)
    const match = matchField(field, memory)

    if (!match.semanticFieldId && !match.ambiguous) continue

    if (match.semanticFieldId) covered.add(match.semanticFieldId)

    // ---------- 经历条目 ----------
    if (match.semanticFieldId?.startsWith("entry.")) {
      const parts = match.semanticFieldId.split(".")
      const kind = (parts[1] ?? "education") as EntryKind
      const prop = (parts[2] ?? "title") as keyof ExperienceEntry
      const rowIndex = field.rowIndex
      const list = entriesOfKind(entries, kind)
      const entry = rowIndex >= 0 ? list[rowIndex] : undefined
      match.reason = match.reason ?? ""

      if (!entry) {
        items.push({
          match,
          action: "missing",
          reason: `资料库缺少该行经历（第 ${rowIndex + 1} 行）`,
          entryIndex: rowIndex,
          entryKind: kind
        })
        continue
      }
      if (entry.state !== "confirmed") {
        items.push({
          match,
          action: "confirm",
          reason: "经历行待核对（needs_review）",
          entryIndex: rowIndex,
          entryKind: kind
        })
        continue
      }
      const raw = prop === "title" || prop === "subtitle" || prop === "start" || prop === "end" || prop === "description"
        ? (entry[prop] ?? "")
        : ""
      if (!raw.trim()) {
        items.push({
          match,
          action: "missing",
          reason: "资料库该行字段为空",
          entryIndex: rowIndex,
          entryKind: kind
        })
        continue
      }
      items.push({
        match,
        action: "fill",
        value: raw,
        entryIndex: rowIndex,
        entryKind: kind
      })
      continue
    }

    // ---------- 标量字段 ----------
    // 歧义 → 确认面板
    if (match.ambiguous || !match.semanticFieldId) {
      items.push({ match, action: "confirm", reason: match.reason ?? "歧义字段" })
      continue
    }

    const id = match.semanticFieldId
    const pf = profileValue(profile, id)
    const memoryValue =
      memory && !memory.ambiguous && memory.value.trim() !== "" ? memory.value : null

    // 资料库缺失 / 待核对 → missing（记忆命中时以记忆值优先，FR-021）
    if (!memoryValue && (!pf || !pf.value.trim())) {
      items.push({ match, action: "missing", reason: "资料库缺失该字段" })
      continue
    }
    if (!memoryValue && pf && pf.state !== "confirmed") {
      items.push({ match, action: "confirm", reason: "资料库字段待核对（needs_review）" })
      continue
    }

    const value = memoryValue ?? (pf as { value: string }).value

    // FR-017 预填冲突
    const current = currentValueOf(field)
    const isPrefilled = current !== ""
    const conflict =
      isPrefilled && !options.allowConflict && !textEquivalent(value, current)
    if (conflict) {
      match.conflict = true
      match.reason = "页面已有内容与资料库不一致，不覆盖（FR-017）"
      items.push({ match, action: "confirm", reason: match.reason, value })
      continue
    }

    // 选项类：措辞不一致 → confirm（gray）
    if (field.controlKind === "select" || field.controlKind === "radio") {
      const optionsList = field.optionTexts ?? []
      const equiv = findEquivalentOption(value, optionsList)
      if (!equiv) {
        items.push({
          match,
          action: "confirm",
          reason: "选项措辞与资料库不一致，不自动填",
          value
        })
        continue
      }
    }

    if (match.confidence === "high") {
      items.push({ match, action: "fill", value })
    } else {
      items.push({
        match,
        action: "confirm",
        reason: match.reason ?? "置信度不足（gray），需人工确认",
        value
      })
    }
  }

  // FR-014: 资料库有值但页面未找到对应字段
  const notFound: string[] = []
  const allIds = [
    ...Object.keys(profile.basics),
    ...Object.keys(profile.intent)
  ]
  for (const id of allIds) {
    const pf = profileValue(profile, id)
    if (pf && pf.value.trim() && !covered.has(id)) notFound.push(id)
  }

  return { items, notFound }
}

export function planReportLabel(match: FieldMatch): string {
  if (match.semanticFieldId) return semanticFieldLabel(match.semanticFieldId)
  return match.field.labelText || match.field.nameIdPlaceholder || "(未识别字段)"
}
