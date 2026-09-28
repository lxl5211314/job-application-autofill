// T042: 生成简历测试夹具 PDF（本地生成，禁止依赖外部文件）
// - resume-text.pdf：带文本层（Type0/Identity-H + ToUnicode CMap），pdf.js 可抽取中文
// - resume-scan.pdf：无文本层（仅图形），扫描件判定用（FR-009, < 100 可见字符）
// - resume-broken.pdf：数字 ToUnicode 全部映射为 <0000>（T056 坏字形修复）
// 用法：node scripts/make-resume-fixtures.mjs

import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, "tests", "fixtures")

// ---------- 简历文本（抽取规则夹具） ----------

const RESUME_LINES = [
  "姓名：张三",
  "手机：13812345678",
  "邮箱：zhangsan@example.com",
  "政治面貌：中共党员",
  "",
  "教育经历",
  "2020.09-2024.06 清华大学 计算机科学与技术 本科",
  "GPA 3.7/4.0，专业排名前 5%",
  "",
  "实习经历",
  "2023.06-2023.12 字节跳动 后端开发实习生",
  "负责订单服务性能优化，接口 P99 下降 40%",
  "",
  "项目经历",
  "2024.01-2024.05 校园二手交易平台 负责人",
  "独立完成前后端开发与部署",
  "",
  "获奖情况",
  "2023.11 校级一等奖学金"
]

const RESUME_TXT = RESUME_LINES.join("\n") + "\n"

// ---------- 极简 PDF 写入器 ----------

function buildPdf(objects) {
  // objects: 按编号顺序的对象体字符串数组（1-based）
  let pdf = "%PDF-1.4\n"
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += "0000000000 65535 f \n"
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return pdf
}

function streamObj(dict, data) {
  const bytes = Buffer.byteLength(data, "utf8")
  return `<< ${dict} /Length ${bytes} >>\nstream\n${data}\nendstream`
}

// 数字固定占 CID 30440-30449（与真实坏 ToUnicode PDF 的子集尾部结构一致，
// T056 修复规则 digit = cid - 30440 的候选 base 推导依赖该跨度）
const DIGIT_BASE = 30440

/** Identity-H Type0 字体 + ToUnicode：CID（顺序编号）→ Unicode
 *  opts.brokenDigits：数字的 ToUnicode 映射为 <0000>（模拟坏字形） */
function makeTextObjects(lines, opts = {}) {
  const { brokenDigits = false } = opts
  const chars = []
  const cidOf = new Map()
  for (let d = 0; d <= 9; d++) cidOf.set(String(d), DIGIT_BASE + d)
  for (const line of lines) {
    for (const ch of line) {
      if (ch === "\n" || ch === "\r") continue
      if (!cidOf.has(ch)) {
        cidOf.set(ch, chars.length + 1) // CID 0 保留（数字不占用该序列）
        chars.push(ch)
      }
    }
  }

  const digitEntries = []
  for (let d = 0; d <= 9; d++) {
    const cid = (DIGIT_BASE + d).toString(16).padStart(4, "0").toUpperCase()
    const uni = brokenDigits ? "0000" : (48 + d).toString(16).padStart(4, "0").toUpperCase()
    digitEntries.push(`<${cid}> <${uni}>`)
  }
  const bfChars = digitEntries
    .concat(
      chars.map((ch, i) => {
        const cid = (i + 1).toString(16).padStart(4, "0").toUpperCase()
        const uni = ch.codePointAt(0).toString(16).padStart(4, "0").toUpperCase()
        return `<${cid}> <${uni}>`
      })
    )
    .join("\n")
  const bfCount = 10 + chars.length
  const toUnicode = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${bfCount} beginbfchar`,
    bfChars,
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end"
  ].join("\n")

  // 内容流：每行一个 Td 定位 + 十六进制 Tj
  let y = 800
  const ops = ["BT", "/F1 12 Tf"]
  for (const line of lines) {
    const hex = [...line]
      .map((ch) => cidOf.get(ch).toString(16).padStart(4, "0").toUpperCase())
      .join("")
    ops.push(`1 0 0 1 50 ${y} Tm <${hex}> Tj`)
    y -= 20
  }
  ops.push("ET")
  const content = ops.join("\n")

  return [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /Sans-Identity /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
    streamObj("", content),
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Sans-Identity /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 >>",
    streamObj("", toUnicode),
    "<< /Type /FontDescriptor /FontName /Sans-Identity /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>"
  ]
}

function makeScanObjects() {
  // 无任何文本操作：仅画一个矩形（模拟图片页）
  const content = "q 0.9 g 50 50 495 742 re f Q"
  return [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
    streamObj("", content)
  ]
}

writeFileSync(join(outDir, "resume-text.pdf"), buildPdf(makeTextObjects(RESUME_LINES)), "utf8")
writeFileSync(join(outDir, "resume-scan.pdf"), buildPdf(makeScanObjects()), "utf8")
writeFileSync(join(outDir, "resume-broken.pdf"), buildPdf(makeTextObjects(RESUME_LINES, { brokenDigits: true })), "utf8")
writeFileSync(join(outDir, "resume.txt"), RESUME_TXT, "utf8")
console.log("fixtures written: resume-text.pdf, resume-scan.pdf, resume-broken.pdf, resume.txt")
