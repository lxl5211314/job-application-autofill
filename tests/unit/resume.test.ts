// T042: 简历导入单测：抽取规则（手机/邮箱/锚点/时间段）、置信度、扫描件判定（FR-009）

import { describe, expect, it } from "vitest"

import {
  MIN_PDF_TEXT_LENGTH,
  NoTextError,
  extractFromText
} from "../../src/core/resume/extract"
import { parseTextResume } from "../../src/core/resume/text"
import { parsePdfResume, pdfText, digitBaseCandidates, repairPageItems } from "../../src/core/resume/pdf"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures")

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
}

function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURE_DIR, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe("抽取规则（resume.txt 统一规则）", () => {
  const result = parseTextResume(fixtureText("resume.txt"))

  it("手机/邮箱正则命中 → high", () => {
    expect(result.fields["basic.phone"]).toEqual({
      value: "13812345678",
      confidence: "high",
      extracted: true
    })
    expect(result.fields["basic.email"]).toEqual({
      value: "zhangsan@example.com",
      confidence: "high",
      extracted: true
    })
  })

  it("“姓名：”锚点命中 → high", () => {
    expect(result.fields["basic.name"]).toEqual({
      value: "张三",
      confidence: "high",
      extracted: true
    })
  })

  it("教育行回填学校/专业/学历 → low（待核对 FR-008）", () => {
    const school = result.fields["basic.school"]
    const major = result.fields["basic.major"]
    const degree = result.fields["basic.degree"]
    expect(school).toMatchObject({ value: "清华大学", confidence: "low", extracted: true })
    expect(major).toMatchObject({ value: "计算机科学与技术", extracted: true })
    expect(degree).toMatchObject({ value: "本科", extracted: true })
    expect(degree?.confidence).toBe("low")
  })

  it("读不到的字段 extracted=false 留空（FR-006：求职意向/期望薪资）", () => {
    expect(result.fields["intent.position"]).toEqual({
      value: "",
      confidence: "low",
      extracted: false
    })
    expect(result.fields["intent.salary"]).toEqual({
      value: "",
      confidence: "low",
      extracted: false
    })
  })

  it("时间段 20xx.09-20xx.06 → 教育/实习/项目条目", () => {
    const edu = result.entries.filter((e) => e.kind === "education")
    expect(edu).toHaveLength(1)
    expect(edu[0]).toMatchObject({
      title: "清华大学",
      subtitle: "计算机科学与技术",
      start: "2020.09",
      end: "2024.06",
      source: "resume",
      order: 0
    })
    expect(edu[0]?.description).toContain("GPA 3.7")

    const intern = result.entries.find((e) => e.kind === "internship")
    expect(intern).toMatchObject({
      title: "字节跳动",
      start: "2023.06",
      end: "2023.12"
    })

    const project = result.entries.find((e) => e.kind === "project")
    expect(project).toMatchObject({ start: "2024.01", end: "2024.05" })
  })

  it("单日期行（获奖）→ award 条目，缺 end → needs_review", () => {
    const award = result.entries.find((e) => e.kind === "award")
    expect(award).toMatchObject({
      title: "校级一等奖学金",
      start: "2023.11",
      state: "needs_review",
      source: "resume"
    })
    expect(award?.end).toBeUndefined()
  })

  it("完整时间段条目 → state=confirmed（未编辑 high → confirmed，FR-007）", () => {
    const edu = result.entries.find((e) => e.kind === "education")
    expect(edu?.state).toBe("confirmed")
  })
})

describe("抽取规则合成文本", () => {
  it("“政治面貌：”锚点命中", () => {
    const { fields } = extractFromText("政治面貌：中共党员\n其他")
    expect(fields["basic.political_status"]).toMatchObject({
      value: "中共党员",
      confidence: "high"
    })
  })

  it("“学历：硕士研究生”锚点命中 → high", () => {
    const { fields } = extractFromText("学历：硕士研究生")
    expect(fields["basic.degree"]).toEqual({
      value: "硕士研究生",
      confidence: "high",
      extracted: true
    })
  })

  it("无任何可识别内容 → 全部字段 extracted=false", () => {
    const { fields, entries } = extractFromText("随便一段没有结构的说明文字而已")
    expect(entries).toHaveLength(0)
    expect(Object.values(fields).every((f) => f?.extracted === false)).toBe(true)
  })

  it("T063 “性别：”锚点 → 归一化为 男/女（Male 也认）", () => {
    expect(extractFromText("性别：男\n手机 13812345678").fields["basic.gender"]).toMatchObject({
      value: "男",
      confidence: "high"
    })
    expect(extractFromText("Gender: Female").fields["basic.gender"]).toMatchObject({
      value: "女",
      confidence: "high"
    })
  })

  it("T063 “出生年月：”锚点 → 提取日期片段", () => {
    const { fields } = extractFromText("出生年月：1999年9月\n政治面貌：共青团员")
    expect(fields["basic.birthday"]).toMatchObject({ value: "1999年9月", confidence: "high" })
    const { fields: f2 } = extractFromText("出生日期：1999-09-15（26岁）")
    expect(f2["basic.birthday"]?.value).toBe("1999-09-15")
  })

  it("T063 性别无法映射（如“保密”）→ 不抽取（校验只认 男/女）", () => {
    const { fields } = extractFromText("性别：保密")
    expect(fields["basic.gender"]?.extracted).toBe(false)
  })
})

describe("扫描件判定（FR-009）", () => {
  it("文本层 PDF：抽取成功且达到阈值", async () => {
    const text = await pdfText(fixtureBytes("resume-text.pdf"))
    expect(text.replace(/\s+/g, "").length).toBeGreaterThanOrEqual(MIN_PDF_TEXT_LENGTH)
    expect(text).toContain("张三")
  })

  it("文本层 PDF → 解析出与 .txt 相同的核心字段", async () => {
    const { fields } = await parsePdfResume(fixtureBytes("resume-text.pdf"))
    expect(fields["basic.name"]?.value).toBe("张三")
    expect(fields["basic.phone"]?.value).toBe("13812345678")
    expect(fields["basic.email"]?.value).toBe("zhangsan@example.com")
  })

  it("无文本层 PDF（扫描件）→ NoTextError 且不产生草稿", async () => {
    await expect(parsePdfResume(fixtureBytes("resume-scan.pdf"))).rejects.toBeInstanceOf(
      NoTextError
    )
  })

  it("纯文本为空 → NoTextError", () => {
    expect(() => parseTextResume("   \n \n")).toThrow(NoTextError)
    expect(() => parseTextResume("")).toThrow(NoTextError)
  })

  it("错误文案引导手动填写（FR-009）", async () => {
    await expect(parsePdfResume(fixtureBytes("resume-scan.pdf"))).rejects.toThrow(
      /无法读取文字.*手动填写/
    )
  })
})

// T056: 坏 ToUnicode 数字修复（数字 cid 30440-30449 → ToUnicode <0000> 的夹具）
describe("坏 ToUnicode 数字修复（T056）", () => {
  const NUL = String.fromCharCode(0)

  it("digitBaseCandidates：cid 跨度 ≤ 10 才有候选，跨度 > 10 → 放弃", () => {
    expect(digitBaseCandidates([])).toEqual([])
    expect(digitBaseCandidates([30440, 30442, 30447, 30449])).toEqual([30440])
    expect(digitBaseCandidates([100, 200])).toEqual([])
    const cands = digitBaseCandidates([30445, 30446])
    expect(cands).toHaveLength(9)
    expect(cands[0]).toBe(30437)
    expect(cands[8]).toBe(30445)
  })

  it("repairPageItems：NUL 按 digit=cid-base 还原，合成空格不参与锁步", () => {
    const items = [{ str: `202${NUL}.0${NUL} x`, transform: [1, 0, 0, 1, 0, 100] }]
    const glyphs = [
      { u: "2", cid: 10 },
      { u: "0", cid: 11 },
      { u: "2", cid: 12 },
      { u: NUL, cid: 30443 },
      { u: ".", cid: 15 },
      { u: "0", cid: 11 },
      { u: NUL, cid: 30449 },
      { u: "x", cid: 40 }
    ]
    const r = repairPageItems(items, glyphs, 30440)
    expect(r.ok).toBe(true)
    expect(r.items[0]?.str).toBe("2023.09 x")
  })

  it("repairPageItems：对齐断裂或 cid 越界 → ok=false（整页回退原文本）", () => {
    const desync = repairPageItems(
      [{ str: `a${NUL}`, transform: [1, 0, 0, 1, 0, 100] }],
      [{ u: "b", cid: 1 }, { u: NUL, cid: 30441 }],
      30440
    )
    expect(desync.ok).toBe(false)
    const outOfRange = repairPageItems(
      [{ str: NUL, transform: [1, 0, 0, 1, 0, 100] }],
      [{ u: NUL, cid: 500 }],
      30440
    )
    expect(outOfRange.ok).toBe(false)
  })

  it("resume-broken.pdf：数字修复后无 NUL、日期/手机号可抽取（与 resume.txt 等价）", async () => {
    const text = await pdfText(fixtureBytes("resume-broken.pdf"))
    expect(text).not.toContain(NUL)
    expect(text).toContain("2020.09-2024.06")
    const { fields, entries } = await parsePdfResume(fixtureBytes("resume-broken.pdf"))
    expect(fields["basic.phone"]?.value).toBe("13812345678")
    expect(fields["basic.email"]?.value).toBe("zhangsan@example.com")
    const edu = entries.find((e) => e.kind === "education")
    expect(edu).toMatchObject({
      title: "清华大学",
      start: "2020.09",
      end: "2024.06",
      state: "confirmed"
    })
    const intern = entries.find((e) => e.kind === "internship")
    expect(intern).toMatchObject({ start: "2023.06", end: "2023.12" })
    const proj = entries.find((e) => e.kind === "project")
    expect(proj).toMatchObject({ start: "2024.01", end: "2024.05" })
  })

  it("正常 PDF（resume-text.pdf）不走修复路径、结果不受影响", async () => {
    const text = await pdfText(fixtureBytes("resume-text.pdf"))
    expect(text).not.toContain(NUL)
    expect(text).toContain("2020.09-2024.06")
  })
})
