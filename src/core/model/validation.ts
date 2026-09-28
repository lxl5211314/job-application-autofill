// T007: 字段校验（data-model §1/§2，spec FR-003）
// 失败返回字段级错误 Record<fieldId, string>；空对象 = 通过

import type { ExperienceEntry, Profile, ScalarFieldId } from "./types"

export const PHONE_RE = /^1[3-9]\d{9}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const MAX_NAME_LENGTH = 60
export const MAX_TEXT_LENGTH = 500
export const MAX_DESCRIPTION_LENGTH = 2000

/** 归一化手机号：去空格/连字符/+86 前缀/括号 */
export function normalizePhone(input: string): string {
  return input.replace(/[\s\-()+]/g, "").replace(/^\+?86/, "")
}

export function normalizeSpace(input: string): string {
  return input.replace(/\s+/g, " ").trim()
}

/** 校验单个 ProfileField 值；返回错误信息或 null */
export function validateScalarValue(fieldId: ScalarFieldId, rawValue: string): string | null {
  const value = rawValue.trim()

  if (fieldId === "basic.name") {
    if (value === "") return "姓名不能为空"
    if (value.length > MAX_NAME_LENGTH) return `姓名不能超过 ${MAX_NAME_LENGTH} 字符`
    return null
  }

  if (fieldId === "basic.phone") {
    if (value === "") return null // 留空 = 缺失，允许
    if (!PHONE_RE.test(normalizePhone(value))) return "手机号格式不正确（需 11 位大陆手机号）"
    return null
  }

  if (fieldId === "basic.email") {
    if (value === "") return null
    if (!EMAIL_RE.test(value)) return "邮箱格式不正确"
    return null
  }

  if (value.length > MAX_TEXT_LENGTH) {
    return `内容不能超过 ${MAX_TEXT_LENGTH} 字符`
  }
  return null
}

/** 校验 Profile 的标量字段（FR-003） */
export function validateProfile(profile: Profile): Record<string, string> {
  const errors: Record<string, string> = {}
  const groups = [
    Object.entries(profile.basics),
    Object.entries(profile.intent)
  ] as const

  for (const group of groups) {
    for (const [fieldId, field] of group) {
      if (!field) continue
      const err = validateScalarValue(fieldId as ScalarFieldId, field.value)
      if (err) errors[fieldId] = err
    }
  }
  return errors
}

const YM_RE = /^\d{4}\.\d{1,2}$/

function normalizeMonth(v: string): string {
  const [y, m] = v.split(".")
  return `${y}.${(m ?? "1").padStart(2, "0")}`
}

/** 校验经历条目（title 必填；start ≤ end；description ≤ 2000） */
export function validateEntry(entry: ExperienceEntry): Record<string, string> {
  const errors: Record<string, string> = {}
  if (entry.title.trim() === "") errors[`${entry.kind}.title`] = "标题/名称不能为空"

  const hasBoth = entry.start !== undefined && entry.end !== undefined && entry.start !== "" && entry.end !== ""
  if (hasBoth) {
    const s = entry.start as string
    const e = entry.end as string
    if (YM_RE.test(s) && YM_RE.test(e)) {
      if (normalizeMonth(s) > normalizeMonth(e)) {
        errors[`${entry.kind}.start`] = "开始时间不能晚于结束时间"
      }
    }
    // "至今" 作为 end 是合法的，不比较
  }
  if ((entry.description ?? "").length > MAX_DESCRIPTION_LENGTH) {
    errors[`${entry.kind}.description`] = `描述不能超过 ${MAX_DESCRIPTION_LENGTH} 字符`
  }
  return errors
}
