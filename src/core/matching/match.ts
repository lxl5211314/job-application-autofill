// T021: 确定性匹配器（contracts/semantic-fields.md §1-§6 置信分档）
// high = 别名精确命中且控件吻合；gray = 包含/仅 name 信号；low = 歧义或无候选

import type { ExperienceEntry, FieldMemory, Profile } from "../model/types"
import {
  AMBIGUOUS_LABELS,
  AUTOCOMPLETE_MAP,
  ENTRY_BLOCK_TITLES,
  ENTRY_COLUMN_ALIASES,
  SCALAR_VOCABULARY,
  findEquivalentOption,
  salaryEquivalent,
  semanticFieldLabel
} from "./vocabulary"
import { normLabel } from "./signature"
import { dateEquivalent } from "../model/date"
import type { EntryKind } from "../model/types"
import type { ScannedField } from "./scan"
import { widgetTriggerText } from "./scan"

export type Confidence = "high" | "gray" | "low"

export interface FieldMatch {
  field: ScannedField
  semanticFieldId: string | null
  confidence: Confidence
  candidates: string[]
  ambiguous: boolean
  conflict: boolean
  /** P1-3：仅 name/id 弱信号命中（词边界+控件过滤后仍存疑）→ 不确认不填写 */
  weak?: boolean
  /** T077：别名精确命中（label 与别名逐一相等）——语义字段已确定，
   *  gray 档下据此高置信直填（控件形态不吻合不改变「填什么」） */
  exact?: boolean
  reason?: string
}

export type PlanAction = "fill" | "confirm" | "missing" | "manual" | "skip"

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
  /** P1-1：仅 name/id 词边界命中（弱信号，置信走 gray 且不进确认） */
  nameIdSignal?: boolean
}

const CJK_RE = /[一-鿿]/

/** name/id 词边界切分：camelCase / 下划线 / 连字符 / 点号 → 单词序列 */
function tokenizeNameId(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t !== "")
    .map((t) => t.toLowerCase())
}

/** alias 词序列是否作为连续片段出现在 tokens 中（hasAppliedOtherJob ≠ 命中 job title） */
function tokensContainSeq(tokens: string[], aliasTokens: string[]): boolean {
  if (aliasTokens.length === 0 || aliasTokens.length > tokens.length) return false
  for (let i = 0; i <= tokens.length - aliasTokens.length; i++) {
    let ok = true
    for (let j = 0; j < aliasTokens.length; j++) {
      if (tokens[i + j] !== aliasTokens[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

function scalarCandidates(field: ScannedField): Candidate[] {
  const label = field.labelText
  const nameIdRaw = field.nameIdPlaceholder
  const nameId = normLabel(nameIdRaw)
  const labelStripped = normLabel(label.replace(/[\s*必填]+$/g, ""))
  const out: Candidate[] = []

  // P1-4：HTML autocomplete 标准属性最高优先（110 > label 精确 100）
  const acTokens = (field.autoComplete ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== "")
  for (const token of acTokens) {
    const id = AUTOCOMPLETE_MAP[token]
    if (id && controlMatches(id, field.controlKind)) {
      out.push({ id, score: 110, exact: true, viaLabel: false })
      break
    }
  }

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
      // P1-1：非精确（部分包含）命中要求控件类型吻合——
      // 「是否支持手机端」下拉不再命中 basic.phone、「已投递岗位」勾选框不再命中 intent.position
      if (score > 0 && (exact || controlMatches(vocab.id, field.controlKind))) {
        out.push({ id: vocab.id, score, exact, viaLabel: true })
      }
    }
  }

  // 仅 name/id 信号（无 label 命中时）：词边界 + 控件吻合（P1-1）
  if (nameId && out.length === 0) {
    const tokens = tokenizeNameId(nameIdRaw)
    for (const vocab of SCALAR_VOCABULARY) {
      if (!controlMatches(vocab.id, field.controlKind)) continue
      const hit = [...vocab.zh, ...vocab.en].some((aliasRaw) => {
        const a = normLabel(aliasRaw)
        if (CJK_RE.test(a)) return nameId.includes(a)
        const aliasTokens = aliasRaw
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t !== "")
        return tokensContainSeq(tokens, aliasTokens)
      })
      if (hit) {
        out.push({ id: vocab.id, score: 45, exact: false, viaLabel: false, nameIdSignal: true })
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
      return { ...base, semanticFieldId: id, confidence: "high", candidates, exact: true }
    }
    return {
      ...base,
      semanticFieldId: id,
      confidence: "gray",
      candidates,
      exact: true,
      reason: "别名命中但控件类型不吻合"
    }
  }

  if (top.score >= 60) {
    return { ...base, semanticFieldId: id, confidence: "gray", candidates, reason: "别名部分包含命中" }
  }

  // 仅 name/id 信号（45 分）→ gray + weak（P1-3：不进确认面板，直接跳过）
  return {
    ...base,
    semanticFieldId: id,
    confidence: "gray",
    candidates,
    weak: top.nameIdSignal === true,
    reason: "仅 name/id 信号命中"
  }
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

// ---------- T061：姓名拆分（姓/名两个输入框的常见布局） ----------

const COMPOUND_SURNAMES = [
  "欧阳", "司马", "上官", "诸葛", "东方", "皇甫", "尉迟", "公孙", "慕容",
  "长孙", "宇文", "司徒", "鲜于", "轩辕", "令狐", "钟离", "闾丘", "夏侯", "南宫"
]

/** 把资料库整名拆到「姓」「名」两个输入框；非拆分字段原样返回 */
function splitNameValue(field: ScannedField, fullName: string): string {
  const rawLabel = field.labelText.replace(/[\s*必填]+$/g, "")
  // 合并的「姓名 / 姓 名」单字段 → 整名
  if (/姓\s*名/.test(rawLabel)) return fullName
  const labelN = normLabel(rawLabel)
  const n = field.nameIdPlaceholder.toLowerCase()
  // 标签与 name/id 都参与判断：国际化表单常见「Last Name/First Name」仅标签、name 为空
  const surnameRe = /surname|lastname|last[\s_-]?name|family[\s_-]?name/
  const givenRe = /given[\s_-]?name|firstname|first[\s_-]?name/
  const isSurname = labelN === "姓" || surnameRe.test(labelN) || surnameRe.test(n)
  const isGiven = labelN === "名" || givenRe.test(labelN) || givenRe.test(n)
  if (!isSurname && !isGiven) return fullName

  const value = fullName.trim()
  if (!value) return value
  if (/[一-鿿]/.test(value)) {
    const len = COMPOUND_SURNAMES.some((c) => value.startsWith(c)) ? 2 : 1
    if (value.length <= len) return isSurname ? value : ""
    return isSurname ? value.slice(0, len) : value.slice(len)
  }
  const parts = value.split(/\s+/)
  if (parts.length >= 2) {
    return isSurname ? (parts[parts.length - 1] as string) : parts.slice(0, -1).join(" ")
  }
  return value
}

function textEquivalent(value: string, current: string): boolean {
  const a = normLabel(value)
  const b = normLabel(current)
  if (a === b) return true
  // T065：日期等价（1999-09-01 ≡ 1999/9/1 ≡ 1999年9月1日）
  if (dateEquivalent(value, current)) return true
  // 电话/纯数字宽松比较
  const da = a.replace(/\D/g, "")
  const db = b.replace(/\D/g, "")
  if (da.length >= 7 && da === db) return true
  return salaryEquivalent(value, current)
}

export function currentValueOf(field: ScannedField): string {
  const el = field.element
  // T065：自定义下拉触发器（div）不是 HTMLSelectElement，读回显文本
  if (field.widget === "combobox") {
    const raw = widgetTriggerText(el)
    if (raw !== "") return raw
    const input = el instanceof HTMLInputElement ? el : el.querySelector("input")
    return (input?.value ?? "").replace(/\s+/g, " ").trim()
  }
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

/** FR-017 冲突比较用的「页面内容」（P1-2）：radio 取选中项可见文案（value 常为 on/1），
 * checkbox 的勾选态不是可比内容，返回空串（永不触发冲突确认） */
function conflictTextOf(field: ScannedField): string {
  if (field.controlKind === "radio" && field.radioGroup) {
    const checked = field.radioGroup.find((r) => r.checked)
    if (!checked) return ""
    const text = (checked.labels?.[0]?.textContent ?? "").replace(/\s+/g, " ").trim()
    return text || checked.value || ""
  }
  if (field.controlKind === "checkbox") return ""
  return currentValueOf(field)
}

export interface PlanOptions {
  memoryBySig?: Map<string, FieldMemory>
  /** 页面预填值与目标不一致时强制覆盖（用户在面板点"覆盖"时用） */
  allowConflict?: boolean
}

/** T068：选项等价比较用实时 options（级联下拉子级在扫描后会被父级 change 重建） */
function liveOptionTexts(field: ScannedField): string[] {
  if (field.controlKind === "select" && field.element instanceof HTMLSelectElement) {
    const live = Array.from(field.element.options)
      .filter((o) => o.value !== "")
      .map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim())
    if (live.length > 0) return live
  }
  return field.optionTexts ?? []
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
  /** T073: 非表格经历行（div 卡片/行容器，无 tr 可依）——同一语义字段
   *  （如 entry.education.title）的出现次序即行号：每行同名字段出现一次，
   *  文档顺序与行顺序一致；表格行（rowIndex≥0）仍走 tr 索引不受影响 */
  const divOcc = new Map<string, number>()

  for (const field of scanned) {
    // T065：只读但可驱动（日历/弹层下拉）→ 走正常标量流程，
    // 执行期由 fillWidgetField 点选弹层；交互失败再降级「需人工」
    const drivable = field.manual === "readonly" && field.widget !== undefined
    if (field.manual && !drivable) {
      // T057：只读控件不填写——仅在匹配到资料字段时上报「需人工」（带字段名），
      // 匹配不上的只读控件不上报（与 FR-019 的静默过滤保持一致，避免噪音）；
      // T062：weak 弱信号同样不上报（否则「我投递错了项目…」这类帮助文本会幻影进需人工）
      if (field.manual === "readonly") {
        const roMatch = matchField(field, null)
        if (roMatch.semanticFieldId && !roMatch.ambiguous && !roMatch.weak) {
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

    // P1-2：勾选框不作为标量填写目标——「是否投过其他岗/是否国内手机」这类
    // 是/否问卷题资料值无法作答；其选中态（value "on"）也永不进 FR-017 冲突确认
    if (field.controlKind === "checkbox") continue

    if (match.semanticFieldId) covered.add(match.semanticFieldId)

    // ---------- 经历条目 ----------
    if (match.semanticFieldId?.startsWith("entry.")) {
      const parts = match.semanticFieldId.split(".")
      const kind = (parts[1] ?? "education") as EntryKind
      const prop = (parts[2] ?? "title") as keyof ExperienceEntry
      let rowIndex = field.rowIndex
      if (rowIndex < 0) {
        // T073: div 型重复行归组（见 divOcc 注释）
        const occ = divOcc.get(match.semanticFieldId) ?? 0
        divOcc.set(match.semanticFieldId, occ + 1)
        rowIndex = occ
      }
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

    // P1-3：仅 name/id 弱信号 → 跳过（报告记「未找到」+原因），不占用确认面板——
    // 成熟插件的共同做法：拿不准的低置信匹配宁可不问也不乱报（73 项确认 → 个位数）
    if (match.weak) {
      items.push({
        match,
        action: "skip",
        reason: "仅 name/id 弱信号命中，置信不足未填写（可在资料页补录该字段）"
      })
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

    const value0 = memoryValue ?? (pf as { value: string }).value
    // T061：姓名拆分字段（姓/名）按页面标签切分；记忆值优先（用户确认过的拆分结果）
    const value =
      id === "basic.name" && !memoryValue ? splitNameValue(field, value0) : value0
    if (id === "basic.name" && value.trim() === "") {
      items.push({ match, action: "missing", reason: "资料库姓名无法拆分出该部分" })
      continue
    }

    // FR-017 预填冲突（P1-2：radio 按选中项可见文案比较，checkbox 已在上方排除）
    const current = conflictTextOf(field)
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
    // T065：widget 驱动控件在扫描期拿不到选项（弹层未打开），等价匹配由驱动层在点选时做
    if ((field.controlKind === "select" || field.controlKind === "radio") && !field.widget) {
      const optionsList = liveOptionTexts(field)
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

    // T077 高置信直填：high 直接填；gray 但别名精确命中（仅控件形态不吻合）同样
    // 属 FR-013 的「高置信度匹配」——填什么已由别名表确定，控件形状不改变语义。
    // 选项措辞/预填冲突/资料待核对/歧义已在上方各分支拦截，仍走确认
    if (match.confidence === "high" || match.exact === true) {
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
