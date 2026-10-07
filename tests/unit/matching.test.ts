// T017: 确定性匹配器单元测试（别名命中、控件类型吻合、灰/低置信分档、unknown 归类）
// 语料来自 tests/fixtures/sample-form.html 字段快照

import { describe, expect, it } from "vitest"

import { matchField, buildFillPlan } from "../../src/core/matching/match"
import { scanDocument, scanReadonlyFields } from "../../src/core/matching/scan"
import { fieldSignature } from "../../src/core/matching/signature"
import type { ScannedField } from "../../src/core/matching/scan"
import type { BasicFieldId, Profile } from "../../src/core/model/types"
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

describe("T058 P1 止血：低置信不进确认 + autocomplete 直填", () => {
  const { profile, entries } = loadProfileFixture()

  it("checkbox 问卷字段不匹配（hasAppliedOtherJob/isDomesticMobile 案例）", () => {
    const doc = new DOMParser().parseFromString(
      `<form>
        <input type="checkbox" name="hasAppliedOtherJob" value="on" />
        <select name="isDomesticMobile"><option value="">请选择</option><option value="a">国内手机</option><option value="b">海外手机</option></select>
      </form>`,
      "text/html"
    )
    const plan = buildFillPlan(scanDocument(doc), profile, entries)
    expect(plan.items.some((i) => i.match.semanticFieldId === "intent.position")).toBe(false)
    expect(plan.items.some((i) => i.match.semanticFieldId === "basic.phone")).toBe(false)
    expect(plan.items.filter((i) => i.action === "confirm")).toHaveLength(0)
  })

  it("name/id 弱信号 → skip（报告归未找到，不进确认面板）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><input name="phone" type="text" /></form>`,
      "text/html"
    )
    const plan = buildFillPlan(scanDocument(doc), profile, entries)
    const item = plan.items.find((i) => i.match.semanticFieldId === "basic.phone")
    expect(item?.action).toBe("skip")
    expect(item?.reason).toContain("弱信号")
    expect(plan.items.filter((i) => i.action === "confirm")).toHaveLength(0)
  })

  it("checkbox 精确标签命中也不进计划（勾选框不作标量目标）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="pf">政治面貌</label><input id="pf" type="checkbox" name="political_flag" /></form>`,
      "text/html"
    )
    const matched = matchField(scanDocument(doc)[0] as ScannedField)
    expect(matched.semanticFieldId).toBe("basic.political_status")
    const plan = buildFillPlan(scanDocument(doc), profile, entries)
    expect(plan.items.filter((i) => i.match.semanticFieldId === "basic.political_status")).toHaveLength(0)
    expect(plan.items.filter((i) => i.action === "confirm")).toHaveLength(0)
  })

  it("autocomplete=email 属性 → high 直填（标准属性最高优先）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><input type="text" name="user_mail_prefill" autocomplete="email" /></form>`,
      "text/html"
    )
    const field = scanDocument(doc)[0] as ScannedField
    const match = matchField(field)
    expect(match.semanticFieldId).toBe("basic.email")
    expect(match.confidence).toBe("high")
    const plan = buildFillPlan(scanDocument(doc), profile, entries)
    expect(plan.items.find((i) => i.match.semanticFieldId === "basic.email")?.action).toBe("fill")
  })

  it("autocomplete=tel 在 text 控件上 → basic.phone high", () => {
    const doc = new DOMParser().parseFromString(
      `<form><input type="text" name="contact_prefill" autocomplete="tel" /></form>`,
      "text/html"
    )
    const match = matchField(scanDocument(doc)[0] as ScannedField)
    expect(match.semanticFieldId).toBe("basic.phone")
    expect(match.confidence).toBe("high")
  })

  it("radio 预选用可见文案比较 value=1 不误报 FR-017 冲突", () => {
    const doc = new DOMParser().parseFromString(
      `<form><fieldset><legend>政治面貌</legend>
        <label><input type="radio" name="political" value="1" checked />中共党员</label>
        <label><input type="radio" name="political" value="2" />共青团员</label>
      </fieldset></form>`,
      "text/html"
    )
    const plan = buildFillPlan(scanDocument(doc), profile, entries)
    const item = plan.items.find((i) => i.match.semanticFieldId === "basic.political_status")
    expect(item?.action).toBe("fill")
  })

  it("S2 学历下拉（label 部分命中）仍进确认（gray 保留，非 name/id 弱信号）", () => {
    const step2 = parseFixture("sample-form-step2.html")
    const plan = buildFillPlan(scanDocument(step2), profile, entries)
    const degree = plan.items.find(
      (i) => i.match.semanticFieldId === "basic.degree" && i.match.field.controlKind === "select"
    )
    expect(degree?.action).toBe("confirm")
    expect(degree?.match.weak).not.toBe(true)
  })
})

describe("T057 只读控件上报（需人工，而非静默未找到）", () => {
  const doc = new DOMParser().parseFromString(
    `<form>
      <label for="deg">学历</label><input id="deg" value="本科" readonly />
      <input id="junk" name="field_9981" readonly />
      <input type="password" readonly />
      <input id="vis" readonly style="display:none" />
      <input id="dis" readonly disabled />
    </form>`,
    "text/html"
  )
  const ro = scanReadonlyFields(doc)

  it("扫描到只读字段并标 manual=readonly；密码/隐藏/禁用被排除", () => {
    expect(ro.map((f) => f.labelText)).toContain("学历")
    expect(ro.every((f) => f.manual === "readonly")).toBe(true)
    expect(ro.some((f) => f.labelText === "")).toBe(true) // 无语义只读控件也扫到，由 plan 过滤
    expect(ro.some((f) => (f.element as HTMLInputElement).type === "password")).toBe(false)
    expect(ro.some((f) => (f.element as HTMLInputElement).disabled)).toBe(false)
    expect(ro.some((f) => (f.element as HTMLElement).style.display === "none")).toBe(false)
  })

  it("FR-019 不变：scanDocument 仍不返回只读控件", () => {
    expect(scanDocument(doc)).toHaveLength(0)
  })

  it("匹配到资料字段的只读 → manual（需人工，带原因）；匹配不上的 → 不上报", () => {
    const { profile: p, entries: e } = loadProfileFixture()
    const plan = buildFillPlan(ro, p, e)
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item?.action).toBe("manual")
    expect(item?.match.semanticFieldId).toBe("basic.degree")
    expect(item?.reason).toContain("只读")
  })

  it("只读签名带 |ro 后缀，不与可编辑字段撞签名", () => {
    const deg = ro.find((f) => f.labelText === "学历")
    expect(deg?.signature.endsWith("|ro")).toBe(true)
  })
})

describe("T061 姓名拆分（姓/名两输入框布局）", () => {
  const splitDoc = new DOMParser().parseFromString(
    `<form>
      <p><label for="s">姓</label><input id="s" name="surname" type="text" /></p>
      <p><label for="g">名</label><input id="g" name="givenName" type="text" /></p>
    </form>`,
    "text/html"
  )

  function nameOnlyProfile(name: string): Profile {
    const p: Profile = { schemaVersion: 1, basics: {}, intent: {} }
    p.basics["basic.name"] = {
      value: name,
      state: "confirmed",
      source: "manual",
      updatedAt: 0
    }
    return p
  }

  it("资料库整名拆到 姓/名 两个输入框（张三 → 张 / 三）", () => {
    const { profile, entries } = loadProfileFixture()
    const plan = buildFillPlan(scanDocument(splitDoc), profile, entries)
    const fills = plan.items.filter(
      (i) => i.action === "fill" && i.match.semanticFieldId === "basic.name"
    )
    expect(fills.map((i) => i.value).sort()).toEqual(["三", "张"])
    expect(plan.notFound).not.toContain("basic.name")
    expect(plan.items.filter((i) => i.action === "confirm")).toHaveLength(0)
  })

  it("复姓（欧阳明）拆成 欧阳 / 明", () => {
    const plan = buildFillPlan(scanDocument(splitDoc), nameOnlyProfile("欧阳明"), [])
    const fills = plan.items.filter(
      (i) => i.action === "fill" && i.match.semanticFieldId === "basic.name"
    )
    expect(fills.map((i) => i.value).sort()).toEqual(["欧阳", "明"].sort())
  })

  it("合并的「姓名」单字段 → 整名不拆", () => {
    const { profile, entries } = loadProfileFixture()
    const doc = new DOMParser().parseFromString(
      `<form><label for="n">姓名</label><input id="n" type="text" /></form>`,
      "text/html"
    )
    const plan = buildFillPlan(scanDocument(doc), profile, entries)
    const fill = plan.items.find((i) => i.match.semanticFieldId === "basic.name")
    expect(fill?.action).toBe("fill")
    expect(fill?.value).toBe("张三")
  })

  it("英文名 John Smith → 姓 Smith / 名 John", () => {
    const plan = buildFillPlan(scanDocument(splitDoc), nameOnlyProfile("John Smith"), [])
    const fills = plan.items.filter(
      (i) => i.action === "fill" && i.match.semanticFieldId === "basic.name"
    )
    expect(fills.map((i) => i.value).sort()).toEqual(["John", "Smith"])
  })

  it("仅英文标签（name 为空）「Last Name/First Name」也拆分", () => {
    const doc = new DOMParser().parseFromString(
      `<form>
        <p><label for="ln">Last Name</label><input id="ln" type="text" /></p>
        <p><label for="fn">First Name</label><input id="fn" type="text" /></p>
      </form>`,
      "text/html"
    )
    const plan = buildFillPlan(scanDocument(doc), nameOnlyProfile("John Smith"), [])
    const fills = plan.items.filter(
      (i) => i.action === "fill" && i.match.semanticFieldId === "basic.name"
    )
    expect(fills.map((i) => i.value).sort()).toEqual(["John", "Smith"])
  })

  it("合并的「Full Name」标签 → 整名不拆", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="fn2">Full Name</label><input id="fn2" type="text" /></form>`,
      "text/html"
    )
    const plan = buildFillPlan(scanDocument(doc), nameOnlyProfile("John Smith"), [])
    const fill = plan.items.find((i) => i.match.semanticFieldId === "basic.name")
    expect(fill?.action).toBe("fill")
    expect(fill?.value).toBe("John Smith")
  })
})

describe("T063 性别/出生日期字段（个人信息区标配）", () => {
  function profileWith(basics: Record<string, string>): Profile {
    const p: Profile = { schemaVersion: 1, basics: {}, intent: {} }
    for (const [id, value] of Object.entries(basics)) {
      p.basics[id as BasicFieldId] = {
        value,
        state: "confirmed",
        source: "manual",
        updatedAt: 0
      }
    }
    return p
  }

  it("性别 radio（男/女）→ 精确命中 high，直填勾选", () => {
    const doc = new DOMParser().parseFromString(
      `<form><fieldset><legend>性别</legend>
        <label><input type="radio" name="gender" value="1" />男</label>
        <label><input type="radio" name="gender" value="2" />女</label>
      </fieldset></form>`,
      "text/html"
    )
    const plan = buildFillPlan(scanDocument(doc), profileWith({ "basic.gender": "女" }), [])
    const item = plan.items.find((i) => i.match.semanticFieldId === "basic.gender")
    expect(item?.action).toBe("fill")
    expect(item?.value).toBe("女")
    expect(item?.match.confidence).toBe("high")
  })

  it("性别 select 措辞「男性」↔ 资料「男」等价 → fill，不进确认", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="ge">性别</label><select id="ge">
        <option value="">请选择</option><option value="m">男性</option><option value="f">女性</option>
      </select></form>`,
      "text/html"
    )
    const plan = buildFillPlan(scanDocument(doc), profileWith({ "basic.gender": "男" }), [])
    const item = plan.items.find((i) => i.match.semanticFieldId === "basic.gender")
    expect(item?.action).toBe("fill")
    expect(plan.items.filter((i) => i.action === "confirm")).toHaveLength(0)
  })

  it("出生日期只读弹层 → fill（T065 日历驱动；执行失败时执行期降级 manual）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="bd">出生日期</label><input id="bd" value="1999-09-01" readonly /></form>`,
      "text/html"
    )
    const plan = buildFillPlan(
      scanReadonlyFields(doc),
      profileWith({ "basic.birthday": "1999-09-01" }),
      []
    )
    const item = plan.items.find((i) => i.match.semanticFieldId === "basic.birthday")
    expect(item?.action).toBe("fill")
    expect(item?.match.field.widget).toBe("date")
  })

  it("资料库无性别 → 页面性别字段报 missing（不再整块静默）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><fieldset><legend>性别</legend>
        <label><input type="radio" name="gender" value="1" />男</label>
      </fieldset></form>`,
      "text/html"
    )
    const plan = buildFillPlan(
      scanDocument(doc),
      { schemaVersion: 1 as const, basics: {}, intent: {} },
      []
    )
    const item = plan.items.find((i) => i.match.semanticFieldId === "basic.gender")
    expect(item?.action).toBe("missing")
  })
})

describe("T062 只读上报排除 weak 弱信号", () => {
  it("无标签 + 仅 name 弱信号的只读控件 → 不上报（幻影需人工案例）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><input name="phone_hint" value="123" readonly /></form>`,
      "text/html"
    )
    const ro = scanReadonlyFields(doc)
    const { profile, entries } = loadProfileFixture()
    const plan = buildFillPlan(ro, profile, entries)
    expect(plan.items.filter((i) => i.action === "manual")).toHaveLength(0)
  })

  it("精确标签只读（学历）→ 仍上报 manual（T057 行为保留）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="d2">学历</label><input id="d2" value="本科" readonly /></form>`,
      "text/html"
    )
    const plan = buildFillPlan(scanReadonlyFields(doc), loadProfileFixture().profile, [])
    const item = plan.items.find((i) => i.match.semanticFieldId === "basic.degree")
    expect(item?.action).toBe("manual")
  })
})
