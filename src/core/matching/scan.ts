// T020: DOM 字段扫描（FR-019 可见可交互判定、label/区块/列抽取、黑名单标记、签名）

import {
  AGREEMENT_PATTERNS,
  BUTTON_PATTERNS,
  CAPTCHA_PATTERNS,
  type ControlKind
} from "./vocabulary"
import { fieldSignature } from "./signature"

export type ManualReason = "password" | "file" | "submit" | "captcha" | "agreement"

export interface ScannedField {
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
  controlKind: ControlKind
  labelText: string
  nameIdPlaceholder: string
  blockTitle: string
  columnLabel: string
  rowIndex: number
  optionTexts?: string[]
  radioGroup?: HTMLInputElement[]
  manual?: ManualReason
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

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text))
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
  blockTitle: string
  columnLabel: string
  rowIndex: number
  optionTexts?: string[]
  radioGroup?: HTMLInputElement[]
  manual?: ManualReason
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

  return results
}
