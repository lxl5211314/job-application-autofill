// T045: 简历抽取规则引擎（research R4：正则+词表，零 LLM；FR-006 留空 / FR-008 待核对）
// PDF 与纯文本共用同一套规则：标量锚点 + 时间段经历行

import type {
  DraftField,
  EntryKind,
  ExperienceEntry,
  ScalarFieldId
} from "../model/types"
import { ALL_SCALAR_FIELD_IDS } from "../model/types"

export interface ExtractResult {
  fields: Partial<Record<ScalarFieldId, DraftField>>
  entries: ExperienceEntry[]
}

/** 扫描件判定阈值（research R4.3，仅对 PDF）：可见文本 < 100 字符 → FR-009 */
export const MIN_PDF_TEXT_LENGTH = 100

// ---------- 文本归一化（真实简历 PDF 常见毛病，T055 加固） ----------
// 1) 部分 PDF 字体把常用汉字映射到康熙部首区块（⽤⼈⼤⽬⼩⼯⼿…），锚点正则匹配不到
//    → NFKD 兼容分解可还原绝大多数（⼈→人、⽤→用、⽬→目…）
// 2) 少数部首区块字符（CJK Radicals Supplement）无兼容分解 → 手工表
// 3) 坏字体把数字映射成 NUL（日期丢失只剩 " . - . "）：PDF 路径先经 pdf.ts 锁步修复（T056：digit = cid - base 还原数字，对齐失败回退原文本）
//    修复失败/纯文本残留的控制字符在此剔除，日期残骸走"无日期条目"回退（state=needs_review 待核对）
const RADICAL_MAP: Record<string, string> = {
  "⻰": "龙", // U+2EF0
  "⻓": "长", // U+2ED3
  "⻔": "门", // U+2ED4
  "⻚": "页" // U+2EDA
}

export function normalizeResumeText(text: string): string {
  const decomposed = text.normalize("NFKD")
  let out = ""
  for (const ch of decomposed) {
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      out += ch
      continue
    }
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x20 || cp === 0x7f) continue // 控制字符（含坏字形 NUL）直接丢弃
    out += RADICAL_MAP[ch] ?? ch
  }
  return out
}

/** FR-009：读不出文字 → 明确报错、不产生草稿/半截数据 */
export class NoTextError extends Error {
  constructor(message = "无法读取文字，请手动填写（扫描件/图片型简历暂不支持）") {
    super(message)
    this.name = "NoTextError"
  }
}

/** 扫描件/空文本判定（PDF 用 100 阈值，纯文本用"无可见字符"） */
export function assertReadableText(text: string, minLength: number): void {
  const visible = text.replace(/\s+/g, "")
  if (visible.length < minLength) throw new NoTextError()
}

// ---------- 标量字段锚点（命中 → high） ----------

interface Anchor {
  id: ScalarFieldId
  re: RegExp
}

const ANCHORS: Anchor[] = [
  { id: "basic.name", re: /(?:姓\s*名|姓\s+名|Name)\s*[:：]\s*([^\r\n,，;；]+)/i },
  { id: "basic.school", re: /(?:毕业院校|最高院校|毕业学校)\s*[:：]\s*([^\r\n]+)/ },
  { id: "basic.major", re: /(?:所学专业|专业名称)\s*[:：]\s*([^\r\n]+)/ },
  {
    id: "basic.degree",
    re: /(?:最高学历|学历)\s*[:：]\s*(大学专科|大专|专科|大学本科|本科|硕士研究生|硕士|博士研究生|博士)/
  },
  { id: "basic.political_status", re: /政治面貌\s*[:：]\s*([^\r\n]+)/ },
  // T063：性别/出生日期（校招简历标配行；性别归一化见 extractFromText）
  { id: "basic.gender", re: /(?:性别|Gender)\s*[:：]\s*([男女]|male|female)/i },
  {
    id: "basic.birthday",
    re: /(?:出生年月日|出生日期|出生年月|出生时间|生日|Birth(?:\s*date)?)\s*[:：]\s*([^\r\n]{4,24})/i
  },
  { id: "intent.position", re: /(?:应聘岗位|意向岗位|求职意向)\s*[:：]\s*([^\r\n]+)/ },
  { id: "intent.city", re: /(?:意向城市|期望城市)\s*[:：]\s*([^\r\n]+)/ },
  { id: "intent.salary", re: /(?:期望薪资|薪资要求)\s*[:：]\s*([^\r\n]+)/ }
]

const PHONE_RE = /(?<!\d)(1[3-9]\d{9})(?!\d)/
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/

// ---------- 经历区块 ----------

const SECTION_HEADERS: Array<[RegExp, EntryKind]> = [
  [/^(?:教育(?:经历|背景)|学习经历)$/, "education"],
  [/^(?:实习(?:经历|经验)|工作(?:经历|经验))$/, "internship"],
  [/^(?:项目(?:经历|经验)|项目)$/, "project"],
  [/^(?:获奖(?:情况|经历)|奖项|荣誉|个人荣誉)$/, "award"]
]

/** 非条目型区块标题：命中则结束当前区块（防止把简介/技能正文误当条目描述） */
const SECTION_ENDERS: RegExp =
  /^(?:个人简介|自我简介|自我评价|个人小结|职业目标|专业技能|个人技能|技能特长|技能清单|语言能力|基本信息|联系方式|求职意向|求职期望|个人信息|证书|资格证书|兴趣爱好)$/

const RANGE_RE = /^(\d{4}\.\d{1,2})\s*[-–—~]\s*(\d{4}\.\d{1,2})\s*(.*)$/
const SINGLE_DATE_RE = /^(\d{4}\.\d{1,2})\s+(\S.*)$/
const TRAILING_RANGE_RE = /(\d{4}\.\d{1,2})\s*[-–—~]\s*(\d{4}\.\d{1,2})\s*$/
/** 数字被坏字体映射成 NUL 后留下的日期残骸：` .  -   . `（空白+. 或 . - .） */
const DATE_ARTIFACT_RE = /\s+\.(?:\s*[-–—~]\s*\.?)?\s*$/
const SENTENCE_PUNCT_RE = /[，,。；;：:、？!]/
const BULLET_RE = /^[•·●▪◆√✓\-–—]/

const DEGREE_WORDS = ["大学专科", "硕士研究生", "博士研究生", "大学本科", "大专", "专科", "硕士", "博士", "本科"]

/** 无有效日期的条目标题行解析：`学校 - 学历 - 专业` / `奖项 - 等级` / `公司 职位` */
function parseEntryTitle(line: string): { tokens: string[]; degree?: string } {
  const parts = line
    .split(/\s+-\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 3 && DEGREE_WORDS.includes(parts[1] as string)) {
    return { tokens: [parts[0] as string, parts[2] as string], degree: parts[1] }
  }
  if (parts.length === 2 && DEGREE_WORDS.includes(parts[1] as string)) {
    return { tokens: [parts[0] as string], degree: parts[1] }
  }
  if (parts.length >= 2) {
    return { tokens: [parts[0] as string, parts.slice(1).join(" - ")] }
  }
  const words = line.split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    return { tokens: [words[0] as string, words.slice(1).join(" ")] }
  }
  return { tokens: [line] }
}

let entrySeq = 0

function newEntryId(): string {
  entrySeq += 1
  return `resume-e${entrySeq}`
}

function makeEntry(
  kind: EntryKind,
  tokens: string[],
  start?: string,
  end?: string
): { entry: ExperienceEntry; confidence: "high" | "low" } | null {
  const title = tokens[0] ?? ""
  if (title.trim() === "") return null
  const subtitle = tokens[1]
  const extra = tokens.slice(2).join(" ")
  const now = Date.now()
  const entry: ExperienceEntry = {
    id: newEntryId(),
    kind,
    order: 0,
    title: title.trim(),
    ...(subtitle ? { subtitle: subtitle.trim() } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(extra ? { description: extra } : {}),
    // FR-007/data-model §5：state 按 confidence 映射（high → confirmed, low → needs_review）
    state: start && end ? "confirmed" : "needs_review",
    source: "resume",
    updatedAt: now
  }
  return { entry, confidence: start && end ? "high" : "low" }
}

function extractEntries(text: string): ExperienceEntry[] {
  const entries: ExperienceEntry[] = []
  let kind: EntryKind | null = null
  let current: ExperienceEntry | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "") continue

    let headerKind: EntryKind | null = null
    for (const [re, k] of SECTION_HEADERS) {
      if (re.test(line)) {
        headerKind = k
        break
      }
    }
    if (headerKind) {
      kind = headerKind
      current = null
      continue
    }
    if (SECTION_ENDERS.test(line)) {
      kind = null
      current = null
      continue
    }
    if (!kind) continue

    const range = RANGE_RE.exec(line)
    if (range) {
      const made = makeEntry(kind, (range[3] ?? "").split(/\s+/).filter(Boolean), range[1], range[2])
      if (made) {
        entries.push(made.entry)
        current = made.entry
        continue
      }
    }
    const single = SINGLE_DATE_RE.exec(line)
    if (single) {
      const made = makeEntry(kind, (single[2] ?? "").split(/\s+/).filter(Boolean), single[1])
      if (made) {
        entries.push(made.entry)
        current = made.entry
        continue
      }
    }
    // 行尾时间段（`公司 职位 2021.09-2025.06`）
    const trailing = TRAILING_RANGE_RE.exec(line)
    if (trailing) {
      const rest = line.replace(TRAILING_RANGE_RE, "").trim()
      const made = rest ? makeEntry(kind, parseEntryTitle(rest).tokens, trailing[1], trailing[2]) : null
      if (made) {
        entries.push(made.entry)
        current = made.entry
        continue
      }
    }
    // 无日期条目回退：日期数字损坏只剩残骸、或标题行本身无日期
    // 门槛：短行 + 无句读标点 + 非列表符号 + （日期残骸 | 区块首行 | 含 " - " 分隔）
    const hasArt = DATE_ARTIFACT_RE.test(line)
    const cleaned = line.replace(DATE_ARTIFACT_RE, "").trim()
    const gated = hasArt || current === null || /\s+-\s/.test(cleaned)
    if (
      gated &&
      cleaned.length > 0 &&
      cleaned.length <= 60 &&
      !SENTENCE_PUNCT_RE.test(cleaned) &&
      !BULLET_RE.test(cleaned) &&
      /[\u4e00-\u9fffA-Za-z]/.test(cleaned)
    ) {
      const parsed = parseEntryTitle(cleaned)
      const made = makeEntry(kind, parsed.tokens)
      if (made) {
        if (parsed.degree) made.entry.description = parsed.degree
        entries.push(made.entry)
        current = made.entry
        continue
      }
    }
    // 续行 → 并入当前条目描述
    if (current) {
      current.description = current.description
        ? `${current.description}\n${line}`
        : line
    }
  }

  // 每类按出现顺序编号 order
  const counters: Record<string, number> = {}
  for (const e of entries) {
    counters[e.kind] = (counters[e.kind] ?? 0)
    e.order = counters[e.kind] as number
    counters[e.kind] = (counters[e.kind] as number) + 1
  }
  return entries
}

/** 无“姓名：”标签简历的回退：首行 `刘小龙 - AI应用开发工程师 …`（T055） */
const NAME_FALLBACK_BLACKLIST = new Set([
  "求职意向",
  "求职期望",
  "基本信息",
  "个人信息",
  "联系方式",
  "教育背景",
  "教育经历"
])

function fallbackName(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
  for (const line of lines) {
    if (/\d/.test(line)) continue
    const m = /^([\u4e00-\u9fff·]{2,4})\s*[-–—|]\s*\S/.exec(line)
    const name = m?.[1]
    if (name && !NAME_FALLBACK_BLACKLIST.has(name)) return name
  }
  return null
}

/** 从经历行回填 school/major/degree 低置信值（教育行：学校 专业 学历） */
function backfillFromEntries(
  fields: Partial<Record<ScalarFieldId, DraftField>>,
  entries: ExperienceEntry[]
): void {
  const edu = entries.find((e) => e.kind === "education")
  if (!edu) return

  const setIfAbsent = (id: ScalarFieldId, value: string): void => {
    const f = fields[id]
    if (f?.extracted && f.value.trim() !== "") return
    if (value.trim() === "") return
    fields[id] = { value: value.trim(), confidence: "low", extracted: true }
  }

  setIfAbsent("basic.school", edu.title)
  if (edu.subtitle) setIfAbsent("basic.major", edu.subtitle)

  const degreeWord = DEGREE_WORDS.find((w) => (edu.description ?? "").includes(w))
  if (degreeWord) setIfAbsent("basic.degree", degreeWord)
}

/** 统一抽取规则：归一化 → 标量锚点 + 正则 + 经历行回填（T042/T045/T055） */
export function extractFromText(raw: string): ExtractResult {
  const text = normalizeResumeText(raw)
  // 全部字段先初始化为"读不到"（FR-006：留空待补）
  const fields: Partial<Record<ScalarFieldId, DraftField>> = {}
  for (const id of ALL_SCALAR_FIELD_IDS) {
    fields[id] = { value: "", confidence: "low", extracted: false }
  }

  const set = (id: ScalarFieldId, value: string, confidence: "high" | "low"): void => {
    const v = value.trim()
    if (v === "") return
    const existing = fields[id]
    if (existing?.extracted && existing.value.trim() !== "") return // 首次命中优先
    fields[id] = { value: v, confidence, extracted: true }
  }

  for (const anchor of ANCHORS) {
    const m = anchor.re.exec(text)
    if (m?.[1]) set(anchor.id, m[1], "high")
  }

  // T063：性别归一化为 男/女（Male/Female/男性…统一），映射不上则清空（校验只认 男/女）
  const gender = fields["basic.gender"]
  if (gender?.extracted) {
    const t = gender.value.trim().toLowerCase()
    if (/^(?:男|male|m)$/.test(t) || /^男/.test(t)) gender.value = "男"
    else if (/^(?:女|female|f)$/.test(t) || /^女/.test(t)) gender.value = "女"
    else fields["basic.gender"] = { value: "", confidence: "low", extracted: false }
  }
  // T063：出生日期从宽松捕获里抠出日期片段（1999年9月 / 1999-09-15 / 1999.09），
  // 抠不出 → 视为没抽到
  const birthday = fields["basic.birthday"]
  if (birthday?.extracted) {
    const m = birthday.value.match(
      /\d{4}(?:\s*[-./年]\s*\d{1,2})?(?:\s*[-./月]\s*\d{1,2}|\s*月)?(?:\s*日)?/
    )
    if (m) birthday.value = m[0].replace(/\s+/g, "")
    else fields["basic.birthday"] = { value: "", confidence: "low", extracted: false }
  }

  const phone = PHONE_RE.exec(text)
  if (phone?.[1]) set("basic.phone", phone[1], "high")

  const email = EMAIL_RE.exec(text)
  if (email) set("basic.email", email[0], "high")

  // 无标签姓名回退（首行 “张小龙 - AI应用开发工程师 …”）→ 不确定 → low 待核对（FR-008）
  if (!fields["basic.name"]?.extracted) {
    const name = fallbackName(text)
    if (name) set("basic.name", name, "low")
  }

  const entries = extractEntries(text)
  backfillFromEntries(fields, entries)

  return { fields, entries }
}
