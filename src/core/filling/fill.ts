// T022: 填充器（FR-018 原生 setter + 事件派发，框架兼容；FR-017 预填保护）

import { findEquivalentOption, salaryEquivalent } from "../matching/vocabulary"
import { normLabel } from "../matching/signature"
import { dateEquivalent, toIsoDate } from "../model/date"
import type { ScannedField } from "../matching/scan"

export interface FillResult {
  filled: boolean
  reason?:
    | "blacklist"
    | "readonly"
    | "disabled"
    | "conflict"
    | "no_match"
    | "no_value"
    /** T066-T067：交互控件驱动失败（弹层未打开/未找到目标项）→ 执行期降级「需人工」 */
    | "widget"
  appliedValue?: string
}

export interface FillOptions {
  /** 用户在面板明确点"覆盖"时置 true（FR-017 例外路径） */
  allowConflict?: boolean
}

type FillableElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

/** 用原型 setter 写值（绕过 React/Vue 的 value tracker）并派发标准事件 */
export function setNativeValue(el: FillableElement, value: string): void {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, "value")
  if (desc && desc.set) {
    desc.set.call(el, value)
  } else {
    ;(el as HTMLInputElement).value = value
  }
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  el.dispatchEvent(new Event("blur"))
}

function textEquivalent(value: string, current: string): boolean {
  if (normLabel(value) === normLabel(current)) return true
  // T065：日期等价（1999-09-01 ≡ 1999/9/1 ≡ 1999年9月1日），不误报冲突
  if (dateEquivalent(value, current)) return true
  const da = normLabel(value).replace(/\D/g, "")
  const db = normLabel(current).replace(/\D/g, "")
  if (da.length >= 7 && da === db) return true
  return salaryEquivalent(value, current)
}

const TRUE_VALUES = new Set(["true", "1", "是", "yes", "y", "on", "√", "真"])

function fillSelect(field: ScannedField, value: string, opts: FillOptions): FillResult {
  const select = field.element as HTMLSelectElement
  // T068 级联兜底：级联下拉的子级 options 会随父级 change 重建——
  // 用实时 options（扫描快照 field.optionTexts 可能已过期），空时才回落快照
  const live = Array.from(select.options)
    .filter((o) => o.value !== "")
    .map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim())
  const options = live.length > 0 ? live : (field.optionTexts ?? [])
  const currentText = select.value === "" ? "" : (select.selectedOptions[0]?.textContent ?? "").trim()

  if (currentText !== "" && !textEquivalent(value, currentText) && !opts.allowConflict) {
    return { filled: false, reason: "conflict" }
  }

  const equiv = findEquivalentOption(value, options)
  if (!equiv) return { filled: false, reason: "no_match" }

  const target = Array.from(select.options).find(
    (o) => (o.textContent ?? "").trim() === equiv
  )
  if (!target) return { filled: false, reason: "no_match" }

  setNativeValue(select, target.value)
  return { filled: true, appliedValue: equiv }
}

function fillRadio(field: ScannedField, value: string, opts: FillOptions): FillResult {
  const group = field.radioGroup ?? []
  const options = field.optionTexts ?? []
  const equiv = findEquivalentOption(value, options)
  if (!equiv) return { filled: false, reason: "no_match" }

  const index = options.findIndex((o) => o === equiv)
  const target = group[index]
  if (!target) return { filled: false, reason: "no_match" }

  const checked = group.find((r) => r.checked)
  if (checked && checked !== target && !textEquivalent(value, equiv) && !opts.allowConflict) {
    if (!textEquivalent(value, (checked.labels?.[0]?.textContent ?? checked.value).trim())) {
      return { filled: false, reason: "conflict" }
    }
  }

  target.click()
  // 通知组内成员（含 field.element，可能是未选中的首项）：派发 input/change
  const notify = new Set<Element>([target, field.element])
  for (const r of notify) {
    r.dispatchEvent(new Event("input", { bubbles: true }))
    r.dispatchEvent(new Event("change", { bubbles: true }))
  }
  return { filled: true, appliedValue: equiv }
}

function fillCheckbox(field: ScannedField, value: string, opts: FillOptions): FillResult {
  const box = field.element as HTMLInputElement
  const desired = TRUE_VALUES.has(value.trim().toLowerCase())
  if (box.checked === desired) return { filled: true, appliedValue: desired ? "true" : "false" }
  if (box.checked && !desired && !opts.allowConflict) {
    return { filled: false, reason: "conflict" }
  }
  box.click()
  return { filled: true, appliedValue: desired ? "true" : "false" }
}

function fillText(field: ScannedField, value: string, opts: FillOptions): FillResult {
  const el = field.element as HTMLInputElement | HTMLTextAreaElement
  const current = (el.value ?? "").trim()
  if (current !== "" && !textEquivalent(value, current) && !opts.allowConflict) {
    return { filled: false, reason: "conflict" }
  }
  // T065：input[type=date] 只接受 ISO（yyyy-mm-dd），自由文本先归一化
  if ((el as HTMLInputElement).type === "date") {
    const iso = toIsoDate(value)
    if (!iso) return { filled: false, reason: "no_match" }
    setNativeValue(el, iso)
    return { filled: true, appliedValue: iso }
  }
  setNativeValue(el, value)
  return { filled: true, appliedValue: value }
}

export function fillField(
  field: ScannedField,
  value: string,
  opts: FillOptions = {}
): FillResult {
  if (field.manual) return { filled: false, reason: "blacklist" }
  if (value.trim() === "") return { filled: false, reason: "no_value" }

  const el = field.element as FillableElement & { disabled?: boolean; readOnly?: boolean }
  if (el.disabled) return { filled: false, reason: "disabled" }
  if (el.readOnly) return { filled: false, reason: "readonly" }

  switch (field.controlKind) {
    case "select":
      return fillSelect(field, value, opts)
    case "radio":
      return fillRadio(field, value, opts)
    case "checkbox":
      return fillCheckbox(field, value, opts)
    default:
      return fillText(field, value, opts)
  }
}
