// T020: DOM 字段扫描（FR-019 可见可交互判定、label/区块/列抽取、黑名单标记、签名）

import {
  AGREEMENT_PATTERNS,
  BUTTON_PATTERNS,
  CAPTCHA_PATTERNS,
  type ControlKind
} from "./vocabulary"
import { fieldSignature } from "./signature"

export type ManualReason = "password" | "file" | "submit" | "captcha" | "agreement" | "readonly"

/** T065：可驱动的交互控件类型——弹层下拉（combobox）与日历面板（date） */
export type WidgetKind = "combobox" | "date"

export interface ScannedField {
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
  controlKind: ControlKind
  labelText: string
  nameIdPlaceholder: string
  /** HTML autocomplete 属性原文（P1-4：标准属性作为最高优先匹配信号） */
  autoComplete?: string
  blockTitle: string
  columnLabel: string
  rowIndex: number
  optionTexts?: string[]
  radioGroup?: HTMLInputElement[]
  manual?: ManualReason
  /** T065：widget 驱动标记——执行期由 fillWidgetField 点选弹层，失败降级「需人工」 */
  widget?: WidgetKind
  prefilled: boolean
  signature: string
}

type AnyControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement

function cleanText(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim()
}

function isHidden(el: Element): boolean {
  if ((el as HTMLElement).hidden) return true
  const style = (el as HTMLElement).getAttribute?.("style") ?? ""
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)
}

function isDisabled(el: AnyControl): boolean {
  return (el as HTMLInputElement).disabled === true
}

function isReadonly(el: AnyControl): boolean {
  return (el as HTMLInputElement).readOnly === true
}

/** 最近的前置标题（h1-h4/legend/caption），用于区块判定 */
function findBlockTitle(el: Element, doc: Document): string {
  const fieldset = el.closest("fieldset")
  if (fieldset) {
    const legend = cleanText(fieldset.querySelector("legend")?.textContent)
    if (legend) return legend
  }
  const headings = doc.querySelectorAll("h1, h2, h3, h4, caption")
  let latest = ""
  for (const h of Array.from(headings)) {
    // 取"元素之前的最近一个标题"：h 在 el 之前 → el compareDocumentPosition(h) 为 PRECEDING
    if (el.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) {
      latest = cleanText(h.textContent)
    }
  }
  return latest
}

function findTableCell(el: Element): { cell: HTMLTableCellElement; rowIndex: number } | null {
  const cell = el.closest("td, th")
  if (!cell) return null
  const tr = cell.closest("tr")
  if (!tr) return null
  const parent = tr.parentElement
  if (!parent) return null
  const isHeaderRow = cell.tagName === "TH" || tr.querySelector("th") !== null
  const rowIndex = Array.from(parent.children).indexOf(tr)
  // 表头行（thead）不产生数据字段；单元格属于数据行才计算 rowIndex
  const inHead = tr.closest("thead") !== null
  return { cell: cell as HTMLTableCellElement, rowIndex: inHead ? -1 : isHeaderRow && inHead ? -1 : rowIndex }
}

function columnLabelOf(cellInfo: { cell: HTMLTableCellElement; rowIndex: number }): string {
  const cell = cellInfo.cell
  const tr = cell.closest("tr")
  if (!tr) return ""
  const cellIndex = Array.from(tr.children).indexOf(cell)
  const table = cell.closest("table")
  const headerRow = table?.querySelector("thead tr") ?? table?.querySelector("tr")
  if (headerRow && headerRow !== tr) {
    const th = headerRow.children[cellIndex]
    if (th) return cleanText(th.textContent)
  }
  // 无表头：取同一行前一格文本作为列提示
  const prev = cell.previousElementSibling
  return prev ? cleanText(prev.textContent) : ""
}

function labelSources(el: AnyControl, _doc: Document): { labelText: string; columnLabel: string; cellRowIndex: number } {
  let columnLabel = ""
  let cellRowIndex = -1

  const cellInfo = findTableCell(el)
  if (cellInfo) {
    columnLabel = columnLabelOf(cellInfo)
    cellRowIndex = cellInfo.rowIndex
  }

  // 1) label[for] / 包裹 label
  let labelText = ""
  const labels = (el as HTMLInputElement).labels
  if (labels && labels.length > 0) {
    labelText = cleanText(labels[0]?.textContent)
  }
  // 2) aria-label
  if (!labelText) labelText = cleanText(el.getAttribute("aria-label"))
  // 3) placeholder
  if (!labelText) labelText = cleanText((el as HTMLInputElement).placeholder)
  // 4) 表格列标题
  if (!labelText) labelText = columnLabel
  // 5) button 用自身文本（如"提交简历"）参与黑名单判定
  if (!labelText && el.tagName.toLowerCase() === "button") {
    labelText = cleanText(el.textContent)
  }
  if (!labelText && ["submit", "button", "image", "reset"].includes(((el as HTMLInputElement).type ?? "").toLowerCase())) {
    labelText = cleanText((el as HTMLInputElement).value)
  }

  return { labelText, columnLabel, cellRowIndex }
}

function nameIdOf(el: AnyControl): string {
  const candidates = [
    el.getAttribute("name") ?? "",
    el.getAttribute("id") ?? "",
    (el as HTMLInputElement).placeholder ?? ""
  ]
  return candidates.sort((a, b) => b.length - a.length)[0] ?? ""
}

function autoCompleteOf(el: Element): string | undefined {
  const v = cleanText(el.getAttribute("autocomplete")).toLowerCase()
  return v === "" ? undefined : v
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text))
}

// ---------- T065: 交互控件（widget）识别 ----------

/** 占位文案（回显空值的判断基准） */
const TRIGGER_PLACEHOLDER_RE =
  /^(?:请选择|点击选择|请点选|请选择日期|请选择时间|选择日期|选择时间|选择|待选择|点击输入|please select|select\d*|placeholder)/i

/** 自定义下拉触发器的当前回显文本（占位文案/placeholder 视为空） */
export function widgetTriggerText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return cleanText(el.value)
  }
  const raw = cleanText(el.textContent)
  if (raw === "") return ""
  if (TRIGGER_PLACEHOLDER_RE.test(raw)) return ""
  const phEl = el.querySelector('[class*="placeholder"]')
  if (phEl && cleanText(phEl.textContent) === raw) return ""
  if (cleanText(el.getAttribute("placeholder")) === raw) return ""
  return raw
}

const DATE_WIDGET_RE = /日期|出生|生日|年月日|毕业时间|入职时间|选择时间|date|birth|calendar|picker/i
const COMBO_WIDGET_RE = /请选择|点击选择|请点选|下拉|选择框|select|dropdown|picker|combobox|listbox/i

/** T065：只读输入是否可由 widget 驱动（日历面板 / 弹层下拉） */
function detectWidget(el: AnyControl, labelText: string): WidgetKind | undefined {
  const input = el as HTMLInputElement
  const type = (input.type ?? "").toLowerCase()
  if (type === "date" || type === "month") return "date"
  const sig = [
    labelText,
    el.getAttribute("name") ?? "",
    el.getAttribute("id") ?? "",
    input.placeholder ?? "",
    el.getAttribute("aria-label") ?? "",
    (el as HTMLElement).className?.toString?.() ?? ""
  ].join(" ")
  if (DATE_WIDGET_RE.test(sig)) return "date"
  if (el.getAttribute("aria-haspopup") || COMBO_WIDGET_RE.test(sig)) return "combobox"
  return undefined
}

function detectManual(el: Element, labelText: string): ManualReason | undefined {
  const tag = el.tagName.toLowerCase()
  const type = ((el as HTMLInputElement).type ?? "").toLowerCase()

  if (tag === "button" || type === "submit" || type === "button" || type === "image" || type === "reset") {
    if (matchesAny(labelText, BUTTON_PATTERNS)) return "submit"
    return undefined // 普通按钮不上报
  }
  if (type === "password") return "password"
  if (type === "file") return "file"
  if (matchesAny(labelText, CAPTCHA_PATTERNS)) return "captcha"
  if ((type === "checkbox" || type === "radio") && matchesAny(labelText, AGREEMENT_PATTERNS)) {
    return "agreement"
  }
  if (matchesAny(labelText, AGREEMENT_PATTERNS) && type === "checkbox") return "agreement"
  return undefined
}

function controlKindOf(el: AnyControl): ControlKind {
  const tag = el.tagName.toLowerCase()
  if (tag === "select") return "select"
  if (tag === "textarea") return "textarea"
  if (tag === "button") return "text"
  const type = ((el as HTMLInputElement).type || "text").toLowerCase()
  if (type === "tel") return "tel"
  if (type === "email") return "email"
  if (type === "radio") return "radio"
  if (type === "checkbox") return "checkbox"
  return "text"
}

function prefilledOf(el: AnyControl, kind: ControlKind, group?: HTMLInputElement[]): boolean {
  if (kind === "radio" && group) return group.some((r) => r.checked)
  if (kind === "select") {
    // 自定义下拉触发器（div[role=combobox]）不是 HTMLSelectElement：看回显文本
    if (!(el instanceof HTMLSelectElement)) return widgetTriggerText(el) !== ""
    const select = el as HTMLSelectElement
    return select.value !== ""
  }
  if (kind === "checkbox") return (el as HTMLInputElement).checked
  return ((el as HTMLInputElement).value ?? "") !== ""
}

function optionTextsOf(el: AnyControl): string[] | undefined {
  if (el.tagName.toLowerCase() !== "select") return undefined
  return Array.from((el as HTMLSelectElement).options)
    .filter((o) => o.value !== "")
    .map((o) => cleanText(o.textContent))
}

function makeField(params: {
  element: ScannedField["element"]
  controlKind: ControlKind
  labelText: string
  nameIdPlaceholder: string
  autoComplete?: string
  blockTitle: string
  columnLabel: string
  rowIndex: number
  optionTexts?: string[]
  radioGroup?: HTMLInputElement[]
  manual?: ManualReason
  widget?: WidgetKind
  prefilled: boolean
}): ScannedField {
  const signature = fieldSignature({
    labelText: params.labelText || params.nameIdPlaceholder,
    controlKind: params.controlKind,
    nameIdPlaceholder: params.nameIdPlaceholder,
    optionTexts: params.optionTexts
  })
  return { ...params, signature }
}

function scanRadioGroups(doc: Document, processed: Set<Element>): ScannedField[] {
  const results: ScannedField[] = []
  const seenGroups = new Set<string>()

  const radios = Array.from(doc.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
  for (const radio of radios) {
    if (isHidden(radio) || isDisabled(radio) || processed.has(radio)) continue
    const groupKey = radio.name ? `name:${radio.name}` : `pos:${radios.indexOf(radio)}`
    if (seenGroups.has(groupKey)) continue
    seenGroups.add(groupKey)

    const group = radios.filter(
      (r) => (radio.name ? r.name === radio.name : r === radio) && r.form === radio.form
    )
    if (group.some((r) => isDisabled(r))) continue
    group.forEach((r) => processed.add(r))

    const fieldset = radio.closest("fieldset")
    const legend = cleanText(fieldset?.querySelector("legend")?.textContent)
    const ariaLabel = cleanText(radio.getAttribute("aria-label"))
    const labelText = legend || ariaLabel || radio.name || ""
    const optionTexts = group.map(
      (r) => cleanText(r.labels?.[0]?.textContent) || cleanText(r.value)
    )
    const manual = detectManual(fieldset ?? radio, labelText || optionTexts.join(" "))

    results.push(
      makeField({
        element: group[0] as ScannedField["element"],
        controlKind: "radio",
        labelText: labelText || optionTexts[0] || "",
        nameIdPlaceholder: radio.name || radio.id || "",
        autoComplete: autoCompleteOf(radio),
        blockTitle: findBlockTitle(radio, doc),
        columnLabel: "",
        rowIndex: -1,
        optionTexts,
        radioGroup: group,
        manual,
        prefilled: prefilledOf(group[0] as ScannedField["element"], "radio", group)
      })
    )
  }
  return results
}

export function scanDocument(doc: Document = document): ScannedField[] {
  const results: ScannedField[] = []
  const processed = new Set<Element>()

  results.push(...scanRadioGroups(doc, processed))

  const controls = Array.from(
    doc.querySelectorAll("input, select, textarea, button")
  ) as AnyControl[]

  for (const el of controls) {
    if (processed.has(el)) continue
    if (el.closest('[id^="job-autofill-"]')) continue
    if (isHidden(el) || isDisabled(el) || isReadonly(el)) continue

    const type = ((el as HTMLInputElement).type ?? "").toLowerCase()
    if (type === "hidden" || type === "radio") continue

    const { labelText, columnLabel, cellRowIndex } = labelSources(el, doc)
    const manual = detectManual(el, labelText)
    const kind = controlKindOf(el)

    // 普通按钮：非黑名单不上报（避免"添加一条"等噪音）
    if (
      !manual &&
      (el.tagName.toLowerCase() === "button" ||
        type === "submit" ||
        type === "button" ||
        type === "image" ||
        type === "reset")
    ) {
      processed.add(el)
      continue
    }

    const blockTitle = findBlockTitle(el, doc)
    const nameId = nameIdOf(el)
    const optionTexts = optionTextsOf(el)

    results.push(
      makeField({
        element: el,
        controlKind: kind,
        labelText,
        nameIdPlaceholder: nameId,
        autoComplete: autoCompleteOf(el),
        blockTitle,
        columnLabel,
        rowIndex: cellRowIndex,
        optionTexts,
        manual,
        prefilled: prefilledOf(el, kind)
      })
    )
    processed.add(el)
  }

  // T065：自定义下拉触发器（原生 input/select 扫描之外）
  scanCustomTriggers(doc, processed, results)

  return results
}

/**
 * T057：只读控件扫描——不参与自动填写（FR-019 仍由 scanDocument 保证），
 * 但会上报为 manual="readonly"；buildFillPlan 仅在能匹配到资料字段时归入
 * 「需人工」，避免只读弹层控件（日期选择器/学校下拉等）静默消失、全被误报成「未找到」。
 */
export function scanReadonlyFields(doc: Document = document): ScannedField[] {
  const results: ScannedField[] = []
  const controls = Array.from(doc.querySelectorAll("input, select, textarea")) as AnyControl[]
  for (const el of controls) {
    if (el.closest('[id^="job-autofill-"]')) continue
    if (isHidden(el) || isDisabled(el)) continue
    if (!isReadonly(el)) continue
    const type = ((el as HTMLInputElement).type ?? "").toLowerCase()
    if (type === "hidden" || type === "radio") continue

    const { labelText, columnLabel, cellRowIndex } = labelSources(el, doc)
    // 密码/上传/验证码/协议等黑名单控件保持原有语义，不重复上报
    if (detectManual(el, labelText)) continue

    const kind = controlKindOf(el)
    const field = makeField({
      element: el,
      controlKind: kind,
      labelText,
      nameIdPlaceholder: nameIdOf(el),
      autoComplete: autoCompleteOf(el),
      blockTitle: findBlockTitle(el, doc),
      columnLabel,
      rowIndex: cellRowIndex,
      optionTexts: optionTextsOf(el),
      manual: "readonly",
      widget: detectWidget(el, labelText),
      prefilled: prefilledOf(el, kind)
    })
    // 只读条目签名加后缀：避免与同名可编辑字段撞签名（itemsBySig/确认回写隔离）
    field.signature = `${field.signature}|ro`
    results.push(field)
  }
  return results
}

// ---------- T065: 自定义下拉触发器扫描（div[role=combobox] 等非原生控件） ----------

function labelOfTrigger(el: Element, doc: Document): string {
  const aria = cleanText(el.getAttribute("aria-label"))
  if (aria) return aria
  const id = el.getAttribute("id")
  if (id) {
    // 不依赖 CSS.escape（jsdom/旧环境未挂载全局 CSS）
    const lbl = Array.from(doc.querySelectorAll("label[for]")).find(
      (l) => l.getAttribute("for") === id
    )
    if (lbl) return cleanText(lbl.textContent)
  }
  const wrap = el.closest("label")
  if (wrap) return cleanText(wrap.textContent)
  const labelledBy = el.getAttribute("aria-labelledby")
  if (labelledBy) {
    for (const refId of labelledBy.split(/\s+/)) {
      const ref = doc.getElementById(refId)
      const text = cleanText(ref?.textContent)
      if (text) return text
    }
  }
  // placeholder 兜底（「请选择」类占位作标签时匹配不上词表，由 plan 静默）
  return cleanText(el.getAttribute("placeholder")) || cleanText(el.querySelector('[class*="placeholder"]')?.textContent)
}

function scanCustomTriggers(doc: Document, processed: Set<Element>, results: ScannedField[]): void {
  const triggers = doc.querySelectorAll(
    '[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="list"]'
  )
  for (const t of Array.from(triggers)) {
    if (processed.has(t)) continue
    if (t.closest('[id^="job-autofill-"]')) continue
    if (isHidden(t)) continue
    if (t.hasAttribute("disabled")) continue
    // 原生控件走主循环（可编辑）或 scanReadonlyFields（只读）
    if (t.matches("input, select, textarea, button")) continue

    const labelText = labelOfTrigger(t, doc)
    const nameId = [t.getAttribute("name") ?? "", t.getAttribute("id") ?? "", t.getAttribute("placeholder") ?? ""]
      .sort((a, b) => b.length - a.length)[0] ?? ""

    results.push(
      makeField({
        element: t as ScannedField["element"],
        controlKind: "select",
        labelText,
        nameIdPlaceholder: nameId,
        autoComplete: autoCompleteOf(t),
        blockTitle: findBlockTitle(t, doc),
        columnLabel: "",
        rowIndex: -1,
        widget: "combobox",
        prefilled: widgetTriggerText(t) !== ""
      })
    )
    processed.add(t)
  }
}
