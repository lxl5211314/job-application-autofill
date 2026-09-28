// T044: pdf.js 集成（本地 worker，FR-024 零外发，research R6）
// getTextContent 逐页拼接 → 统一抽取规则；扫描件判定（< 100 可见字符 → FR-009）
// T056: 坏 ToUnicode 日期数字修复——NUL 字形经 getOperatorList 锁步对齐后按 cid 还原数字

import {
  MIN_PDF_TEXT_LENGTH,
  assertReadableText,
  extractFromText,
  type ExtractResult
} from "./extract"

/** pdf.js getTextContent 的文本项（类型内联，避免依赖 pdfjs-dist 内部导出） */
interface PdfTextItem {
  str: string
  transform: number[]
  hasEOL?: boolean
}

/** 锁步对齐用的字形记录：u = getTextContent 同源 unicode，cid = originalCharCode */
interface GlyphRec {
  u: string
  cid: number
}

/** 一页的文本项 + 字形流（无坏字形的页 glyphs=null，不参与修复） */
interface PageRecord {
  items: PdfTextItem[]
  glyphs: GlyphRec[] | null
}

const NUL = String.fromCharCode(0)

// pdf.js 4.x 需要 Promise.withResolvers（Node 18 / 旧 Chrome 缺失）→ 补齐
const P = Promise as unknown as {
  withResolvers?: <T>() => { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
}
if (typeof P.withResolvers !== "function") {
  P.withResolvers = function <T>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

// ---------- 坏 ToUnicode 数字修复（T056） ----------

/** 修复候选年份/月份：`2020.09` / `2025.5`（月 01-12），用于给候选 base 打分 */
const DATE_LIKE_RE = /(?:19|20)\d{2}\.(?:0?[1-9]|1[0-2])/g

/** 数字字形 cid 候选基址：digit = cid - base，全部 cid 必须落入 [base, base+9] */
export function digitBaseCandidates(cids: number[]): number[] {
  if (cids.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const c of cids) {
    if (c < min) min = c
    if (c > max) max = c
  }
  const lo = max - 9
  const hi = min
  const out: number[] = []
  for (let b = lo; b <= hi; b++) out.push(b)
  return out
}

/** showText 字形流提取（unicode + originalCharCode；结构异常返回 null → 放弃修复） */
function collectGlyphs(
  pl: { fnArray: number[]; argsArray: unknown[][] },
  showOps: Set<number>
): GlyphRec[] | null {
  const out: GlyphRec[] = []
  for (let i = 0; i < pl.fnArray.length; i++) {
    if (!showOps.has(pl.fnArray[i] as number)) continue
    const arg0 = pl.argsArray[i]?.[0]
    if (!Array.isArray(arg0)) return null
    for (const g of arg0) {
      if (!g || typeof g !== "object") continue
      const glyph = g as { unicode?: unknown; originalCharCode?: unknown }
      out.push({
        u: typeof glyph.unicode === "string" ? glyph.unicode : "",
        cid: typeof glyph.originalCharCode === "number" ? glyph.originalCharCode : -1
      })
    }
  }
  return out
}

/**
 * 锁步对齐替换：getTextContent 逐字符 vs 字形流（合成空格不消费字形）。
 * NUL 字形按 digit = cid - base 还原；对齐断裂或 cid 越界 → ok=false（整页回退原文本，禁错替换）
 */
export function repairPageItems(
  items: PdfTextItem[],
  glyphs: GlyphRec[],
  base: number
): { items: PdfTextItem[]; ok: boolean } {
  let gi = 0
  let desync = 0
  let unresolved = 0
  const out = items.map((it) => {
    if (typeof it.str !== "string") return it
    let s = ""
    for (const ch of it.str) {
      const g = glyphs[gi]
      if (!g) {
        desync++
        s += ch
        continue
      }
      if (ch === " " && g.u !== " ") {
        s += ch
        continue
      }
      gi++
      if (g.u === ch) {
        if (ch === NUL) {
          const d = g.cid - base
          if (d >= 0 && d <= 9) s += String(d)
          else {
            unresolved++
            s += ch
          }
        } else s += ch
      } else {
        desync++
        s += ch
        break
      }
    }
    return { ...it, str: s }
  })
  return { items: out, ok: desync === 0 && unresolved === 0 }
}

/** 按某个 base 修复全部坏字形页；任一页对齐失败 → null（该候选废弃） */
function repairAllPages(pages: PageRecord[], base: number): PdfTextItem[][] | null {
  const result: PdfTextItem[][] = []
  for (const p of pages) {
    if (!p.glyphs) {
      result.push(p.items)
      continue
    }
    const r = repairPageItems(p.items, p.glyphs, base)
    if (!r.ok) return null
    result.push(r.items)
  }
  return result
}

/** 拼接文本项 → 页文本（与原逻辑一致：y 跳变/hasEOL 换行） */
function pageText(items: PdfTextItem[]): string {
  let out = ""
  let lastY: number | null = null
  for (const item of items) {
    if (typeof item.str !== "string") continue
    const y = item.transform[5] as number
    if (lastY !== null && Math.abs(y - lastY) > 2) out += "\n"
    out += item.str
    if (item.hasEOL) {
      out += "\n"
      lastY = null
      continue
    }
    lastY = y
  }
  return out
}

/**
 * 坏数字修复总入口：候选 base × 全页锁步修复 → 按合法日期数打分。
 * 无合法日期（score 0）或候选并列 → 返回原文本（宁缺勿错）。
 */
function repairNulPages(pages: PageRecord[], nulCids: number[]): string {
  const original = pages.map((p) => pageText(p.items)).join("\n")
  const candidates = digitBaseCandidates(nulCids)
  if (candidates.length === 0) return original
  let best: PdfTextItem[][] | null = null
  let bestScore = 0
  let winners = 0
  for (const base of candidates) {
    const repaired = repairAllPages(pages, base)
    if (!repaired) continue
    const text = repaired.map((items) => pageText(items)).join("\n")
    const score = text.match(DATE_LIKE_RE)?.length ?? 0
    if (score > bestScore) {
      bestScore = score
      best = repaired
      winners = 1
    } else if (score === bestScore && score > 0) {
      winners++
    }
  }
  if (!best || bestScore === 0 || winners > 1) return original
  return best.map((items) => pageText(items)).join("\n")
}

/** 逐页拼接可见文本；扩展环境用本地 worker（chrome.runtime.getURL，禁 CDN） */
async function loadPdfText(data: ArrayBuffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist")
  const g = globalThis as {
    chrome?: { runtime?: { getURL?: (p: string) => string } }
  }
  const getURL = g.chrome?.runtime?.getURL
  if (getURL) {
    pdfjs.GlobalWorkerOptions.workerSrc = getURL("resources/pdf.worker.mjs")
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    fontExtraProperties: true
  }).promise
  try {
    const showOps = new Set<number>([
      pdfjs.OPS.showText,
      pdfjs.OPS.showSpacedText,
      pdfjs.OPS.nextLineShowText,
      pdfjs.OPS.nextLineSetSpacingShowText
    ])
    const pages: PageRecord[] = []
    const nulCids: number[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      const items = content.items.filter((it) => "str" in it) as unknown as PdfTextItem[]
      const hasNul = items.some((it) => it.str.includes(NUL))
      if (!hasNul) {
        pages.push({ items, glyphs: null })
        continue
      }
      // 坏 ToUnicode 页：关归一化重取（保证 str 与字形 unicode 可逐字符对齐）
      const content2 = await page.getTextContent({ includeMarkedContent: false, disableNormalization: true })
      const items2 = content2.items.filter((it) => "str" in it) as unknown as PdfTextItem[]
      let glyphs: GlyphRec[] | null = null
      try {
        const pl = await page.getOperatorList()
        glyphs = collectGlyphs(pl, showOps)
      } catch {
        glyphs = null // 拿不到字形流 → 本页保留原文本（NUL 由下游剔除）
      }
      if (glyphs) {
        for (const g2 of glyphs) if (g2.u === NUL) nulCids.push(g2.cid)
      }
      pages.push({ items: items2, glyphs })
    }
    if (nulCids.length === 0) return pages.map((p) => pageText(p.items)).join("\n")
    return repairNulPages(pages, nulCids)
  } finally {
    await doc.destroy()
  }
}

/** PDF → 文本 → 统一抽取；扫描件抛 NoTextError（不产生任何草稿数据，FR-009） */
export async function parsePdfResume(data: ArrayBuffer): Promise<ExtractResult> {
  const text = await loadPdfText(data)
  assertReadableText(text, MIN_PDF_TEXT_LENGTH)
  return extractFromText(text)
}

/** 仅抽取文本（草稿预览/测试用） */
export async function pdfText(data: ArrayBuffer): Promise<string> {
  return loadPdfText(data)
}
