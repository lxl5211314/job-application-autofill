// FillReport 掩码辅助（data-model §4 / S10）：手机号/邮箱仅以掩码入库与展示

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "")
  if (digits.length >= 7) {
    return `${digits.slice(0, 3)}${"*".repeat(Math.max(digits.length - 7, 1))}${digits.slice(-4)}`
  }
  return "***"
}

export function maskEmail(value: string): string {
  const at = value.indexOf("@")
  if (at <= 0) return "***"
  const name = value.slice(0, at)
  const domain = value.slice(at)
  const head = name.slice(0, 1)
  return `${head}${"*".repeat(Math.max(name.length - 1, 3))}${domain}`
}

/** 按语义字段掩码展示值；非敏感字段原样返回 */
export function maskValue(semanticFieldId: string | null | undefined, value: string): string {
  if (!semanticFieldId) return value
  if (semanticFieldId === "basic.phone") return maskPhone(value)
  if (semanticFieldId === "basic.email") return maskEmail(value)
  return value
}
