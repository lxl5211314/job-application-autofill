// T017: 确定性匹配器单元测试（别名命中、控件类型吻合、灰/低置信分档、unknown 归类）
// 语料来自 tests/fixtures/sample-form.html 字段快照

import { describe, expect, it } from "vitest"

import { matchField, buildFillPlan } from "../../src/core/matching/match"
import { scanDocument } from "../../src/core/matching/scan"
import { fieldSignature } from "../../src/core/matching/signature"
import type { ScannedField } from "../../src/core/matching/scan"
import { loadProfileFixture, parseFixture } from "./helpers/seed-profile"

const fixtureDoc = parseFixture("sample-form.html")
const scanned = scanDocument(fixtureDoc)

function byLabel(doc: Document, labelText: string): ScannedField | undefined {
  return scanDocument(doc).find((f) => f.labelText === labelText)
}

describe("scan（sample-form 快照）", () => {
  it("覆盖核心字段类型 text/tel/email/select/radio/textarea", () => {
    const labels = scanned.map((f) => f.labelText)
    expect(labels).toContain("姓名")
    expect(labels).toContain("手机号码")
    expect(labels).toContain("邮箱")
    expect(labels).toContain("最高学历")
    expect(labels).toContain("政治面貌")
    expect(labels).toContain("自我评价")
    expect(scanned.some((f) => f.controlKind === "radio")).toBe(true)
    expect(scanned.some((f) => f.controlKind === "select")).toBe(true)
    expect(scanned.some((f) => f.controlKind === "textarea")).toBe(true)
  })

  it("非填写区控件被标 manual（密码/上传/验证码/条款/提交）", () => {
    const manual = scanned.filter((f) => f.manual)
    const reasons = manual.map((f) => f.manual)
    expect(reasons).toContain("password")
    expect(reasons).toContain("file")
    expect(reasons).toContain("captcha")
    expect(reasons).toContain("agreement")
    expect(reasons).toContain("submit")
  })

  it("disabled/readonly 不参与扫描（FR-019）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><input id="d" name="d" disabled /><input id="r" name="r" readonly /></form>`,
      "text/html"
    )
    expect(scanDocument(doc)).toHaveLength(0)
  })

  it("表格单元格抽取列标题与行号（经历区块信号）", () => {
    const cell = scanned.find((f) => f.nameIdPlaceholder === "edu1_school")
    expect(cell).toBeDefined()
    expect(cell?.columnLabel).toBe("学校名称")
    expect(cell?.blockTitle).toContain("教育经历")
    expect(cell?.rowIndex).toBe(0)
    const cell2 = scanned.find((f) => f.nameIdPlaceholder === "edu2_school")
    expect(cell2?.rowIndex).toBe(1)
  })
})

describe("matchField 别名命中与置信分档", () => {
  it("精确别名 + 控件吻合 → high", () => {
    const cases: Array<[string, string]> = [
      ["姓名", "basic.name"],
      ["手机号码", "basic.phone"],
      ["邮箱", "basic.email"],
      ["毕业院校", "basic.school"],
      ["所学专业", "basic.major"],
      ["最高学历", "basic.degree"],
      ["政治面貌", "basic.political_status"],
      ["应聘岗位", "intent.position"],
      ["意向城市", "intent.city"],
      ["期望薪资", "intent.salary"]
    ]
    for (const [label, expectedId] of cases) {
      const field = byLabel(fixtureDoc, label)
      expect(field, `缺少字段 ${label}`).toBeDefined()
      const match = matchField(field as ScannedField)
      expect(match.semanticFieldId, label).toBe(expectedId)
      expect(match.confidence, label).toBe("high")
    }
  })

  it("联系人姓名不命中 basic.name（词表排除）", () => {
    const field = byLabel(fixtureDoc, "联系人姓名")
    const match = matchField(field as ScannedField)
    expect(match.semanticFieldId).not.toBe("basic.name")
    expect(match.semanticFieldId).toBeNull()
  })

  it("歧义标签（自我评价）→ ambiguous + low", () => {
    const field = byLabel(fixtureDoc, "自我评价")
    const match = matchField(field as ScannedField)
    expect(match.ambiguous).toBe(true)
    expect(match.confidence).toBe("low")
    expect(match.semanticFieldId).toBeNull()
  })

  it("无候选字段 → semanticFieldId null（unknown 归类）", () => {
    const field = byLabel(fixtureDoc, "兴趣爱好")
    const match = matchField(field as ScannedField)
    expect(match.semanticFieldId).toBeNull()
    expect(match.confidence).toBe("low")
  })

  it("仅 name/id 信号（无 label）→ gray 分档", () => {
    const doc = new DOMParser().parseFromString(
      `<form><input name="phone" type="text" /></form>`,
      "text/html"
    )
    const field = scanDocument(doc)[0] as ScannedField
    const match = matchField(field)
    expect(match.semanticFieldId).toBe("basic.phone")
    expect(match.confidence).toBe("gray")
  })

  it("同名不同选项集 → 签名不串值（§5）", () => {
    const a = fieldSignature({
      labelText: "学历",
      controlKind: "select",
      nameIdPlaceholder: "degree",
      optionTexts: ["大学本科", "硕士研究生"]
    })
    const b = fieldSignature({
      labelText: "学历",
      controlKind: "select",
      nameIdPlaceholder: "degree",
      optionTexts: ["高中", "大专"]
    })
    expect(a).not.toBe(b)
    const a2 = fieldSignature({
      labelText: "学历",
      controlKind: "select",
      nameIdPlaceholder: "degree",
      optionTexts: ["硕士研究生", "大学本科"]
    })
    expect(a).toBe(a2) // 顺序无关
  })
})

describe("buildFillPlan（含 FR-017 冲突与缺失判定）", () => {
  const { profile, entries } = loadProfileFixture()

  it("十项标量字段全部 fill，经历行按序映射", () => {
    const plan = buildFillPlan(scanned, profile, entries)
    const fillIds = plan.items
      .filter((i) => i.action === "fill" && i.match.semanticFieldId)
      .map((i) => i.match.semanticFieldId)
    for (const id of [
      "basic.name",
      "basic.phone",
      "basic.email",
      "basic.school",
      "basic.major",
      "basic.degree",
      "basic.political_status",
      "intent.position",
      "intent.city",
      "intent.salary"
    ]) {
      expect(fillIds, id).toContain(id)
    }
    expect(plan.notFound).toEqual([])
  })

  it("页面预填且与资料库不一致 → confirm（不覆盖，FR-017）", () => {
    const plan = buildFillPlan(scanned, profile, entries)
    const conflict = plan.items.find(
      (i) => i.match.semanticFieldId === "basic.phone" && i.match.conflict
    )
    expect(conflict).toBeDefined()
    expect(conflict?.action).toBe("confirm")
    expect(conflict?.match.reason).toContain("不覆盖")
  })

  it("manual 控件 → manual 动作（FR-018）", () => {
    const plan = buildFillPlan(scanned, profile, entries)
    const manuals = plan.items.filter((i) => i.action === "manual")
    expect(manuals.length).toBeGreaterThanOrEqual(5)
  })

  it("资料库缺失对应值 → missing_in_profile（FR-015）", () => {
    const emptyProfile = { schemaVersion: 1 as const, basics: {}, intent: {} }
    const plan = buildFillPlan(scanned, emptyProfile, [])
    const missings = plan.items.filter((i) => i.action === "missing")
    expect(missings.length).toBeGreaterThan(5)
  })

  it("经历行数超出资料库条目 → missing", () => {
    const plan = buildFillPlan(scanned, profile, entries)
    const eduRow1 = plan.items.find(
      (i) => i.entryIndex === 0 && i.match.semanticFieldId === "entry.education.title"
    )
    const eduRow2 = plan.items.find(
      (i) => i.entryIndex === 1 && i.match.semanticFieldId === "entry.education.title"
    )
    expect(eduRow1?.action).toBe("fill")
    expect(eduRow2?.action).toBe("missing")
  })

  it("资料库标量字段在页面无对应 → notFound（FR-014）", () => {
    const step2 = parseFixture("sample-form-step2.html")
    const plan = buildFillPlan(scanDocument(step2), profile, entries)
    expect(plan.notFound).toContain("basic.name")
    expect(plan.notFound).toContain("intent.salary")
  })

  it("S2：学历措辞不一致的下拉 → confirm（gray，不自动填）", () => {
    const step2 = parseFixture("sample-form-step2.html")
    const plan = buildFillPlan(scanDocument(step2), profile, entries)
    const degree = plan.items.find(
      (i) => i.match.semanticFieldId === "basic.degree" && i.match.field.controlKind === "select"
    )
    expect(degree).toBeDefined()
    expect(degree?.action).toBe("confirm")
    expect(degree?.match.confidence).not.toBe("high")
  })
})
