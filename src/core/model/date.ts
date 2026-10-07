// T065+: 日期归一化与等价比较（model 层叶子模块，无依赖）
// 资料库日期是自由文本（1999-09-01 / 1999/9/1 / 1999年9月1日 / 1999年9月），
// 页面侧可能是 input[type=date] 的 ISO、日历面板的 title、或本地化展示串——
// 这里提供统一的解析 → 等价比较 → ISO 归一化

export interface DateParts {
  y: number
  m: number
  /** 缺日（如「1999年9月」）时为 undefined，比较时缺日宽恕 */
  d?: number
}

/** 解析自由文本日期；无法识别返回 null（不猜非日期文本） */
export function dateParts(value: string): DateParts | null {
  const s = (value ?? "").trim()
  if (!s) return null
  const full = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/)
  if (full) {
    const y = Number(full[1])
    const m = Number(full[2])
    const d = Number(full[3])
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { y, m, d }
    return null
  }
  const ym = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?\s*$/)
  if (ym) {
    const y = Number(ym[1])
    const m = Number(ym[2])
    if (m >= 1 && m <= 12) return { y, m }
  }
  return null
}

/** → input[type=date] 的 ISO；年月缺日按当月 1 号补全；无法解析返回 null */
export function toIsoDate(value: string): string | null {
  const p = dateParts(value)
  if (!p) return null
  const mm = String(p.m).padStart(2, "0")
  const dd = String(p.d ?? 1).padStart(2, "0")
  return `${p.y}-${mm}-${dd}`
}

/** 日期等价：年月必等；两边都有日时日也必须等（任一边缺日则宽恕） */
export function dateEquivalent(a: string, b: string): boolean {
  const pa = dateParts(a)
  const pb = dateParts(b)
  if (!pa || !pb) return false
  if (pa.y !== pb.y || pa.m !== pb.m) return false
  if (pa.d !== undefined && pb.d !== undefined && pa.d !== pb.d) return false
  return true
}
