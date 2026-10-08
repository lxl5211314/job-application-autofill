// T032: 确认路由单测（FR-013/014/017）
// 歧义/资料待核对/预填冲突/选项措辞不一致 → confirm（needs_confirm）且不自动填；
// T058 P1-3：仅 name/id 弱信号 → skip（不进确认面板，报告归未找到）；
// 候选值逐字来自页面选项（select 措辞不一致时 value 用资料库值、候选列表为页面原文）

import { describe, expect, it } from "vitest"

import { buildFillPlan, matchField } from "../../src/core/matching/match"
import { scanDocument, type ScannedField } from "../../src/core/matching/scan"
import { loadProfileFixture, parseFixture } from "./helpers/seed-profile"
import type { Profile } from "../../src/core/model/types"

const { profile, entries } = loadProfileFixture()
const fixtureDoc = parseFixture("sample-form.html")

function byLabel(doc: Document, labelText: string): ScannedField | undefined {
  return scanDocument(doc).find((f) => f.labelText === labelText)
}

function planWith(doc: Document, p: Profile = profile) {
  return buildFillPlan(scanDocument(doc), p, entries)
}

describe("低置信/歧义 → needs_confirm", () => {
  it("歧义标签（自我评价）→ confirm，且字段未被填", () => {
    const field = byLabel(fixtureDoc, "自我评价") as ScannedField
    const plan = buildFillPlan([field], profile, entries)
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item?.action).toBe("confirm")
    expect(item?.value).toBeUndefined() // 无候选值
    expect(item?.match.ambiguous).toBe(true)
  })

  it("gray（仅 name/id 信号）→ skip 不确认不填（T058 P1-3）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><input name="phone" type="text" /></form>`,
      "text/html"
    )
    const field = scanDocument(doc)[0] as ScannedField
    const plan = buildFillPlan([field], profile, entries)
    expect(plan.items[0]?.action).toBe("skip")
    expect(plan.items[0]?.match.confidence).toBe("gray")
    expect(plan.items[0]?.match.weak).toBe(true)
    expect(plan.items[0]?.reason).toContain("弱信号")
  })

  it("资料库待核对（needs_review）→ confirm", () => {
    const p: Profile = {
      ...profile,
      basics: {
        ...profile.basics,
        "basic.name": {
          value: "张三",
          state: "needs_review",
          source: "manual",
          updatedAt: 0
        }
      }
    }
    const field = byLabel(fixtureDoc, "姓名") as ScannedField
    const plan = buildFillPlan([field], p, entries)
    expect(plan.items[0]?.action).toBe("confirm")
    expect(plan.items[0]?.reason).toContain("待核对")
  })
})

describe("预填冲突（FR-017）→ needs_confirm 不覆盖", () => {
  it("页面预填值与资料库不一致 → confirm 且 reason 提示不覆盖", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label>手机号码 <input name="phone" value="19911112222" /></label></form>`,
      "text/html"
    )
    const plan = planWith(doc)
    const item = plan.items[0]
    expect(item?.action).toBe("confirm")
    expect(item?.match.conflict).toBe(true)
    expect(item?.reason).toContain("不覆盖")
    // 页面原值保持不动（fillField 未被调用）
    const input = doc.querySelector("input") as HTMLInputElement
    expect(input.value).toBe("19911112222")
  })

  it("页面预填值与资料库一致 → 正常 fill", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="p">手机号码</label><input id="p" name="phone" type="tel" value="13812345678" /></form>`,
      "text/html"
    )
    const plan = planWith(doc)
    expect(plan.items[0]?.action).toBe("fill")
    expect(plan.items[0]?.value).toBe("13812345678")
  })
})

describe("选项措辞不一致 → confirm（FR-013 候选逐字来自页面）", () => {
  it("select 无等价选项 → confirm，reason 说明措辞不一致", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="deg1">最高学历</label>
        <select id="deg1" name="degree">
          <option value="">请选择</option>
          <option value="1">大学专科</option>
          <option value="2">大学本科（统招）</option>
        </select></form>`,
      "text/html"
    )
    const plan = planWith(doc)
    const item = plan.items[0]
    expect(item?.action).toBe("confirm")
    expect(item?.reason).toContain("选项措辞")
    // 资料库值原样带入（供面板展示），页面 select 未被改写
    expect(item?.value).toBe(profile.basics["basic.degree"]?.value)
    const select = doc.querySelector("select") as HTMLSelectElement
    expect(select.value).toBe("")
  })

  it("select 等价选项（本科↔Bachelor 类）→ fill 页面原文", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="deg">最高学历</label>
        <select id="deg" name="degree">
          <option value="">请选择</option>
          <option value="bachelor">Bachelor</option>
          <option value="master">Master</option>
        </select></form>`,
      "text/html"
    )
    const plan = planWith(doc)
    expect(plan.items[0]?.action).toBe("fill")
    expect(plan.items[0]?.value).toBe("本科")
  })
})

describe("面板候选值来源", () => {
  it("select confirm 项的候选 = 页面选项原文（逐字，不含空占位项）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="deg2">最高学历</label>
        <select id="deg2" name="degree">
          <option value="">请选择</option>
          <option value="1">大学专科</option>
          <option value="2">大学本科（统招）</option>
        </select></form>`,
      "text/html"
    )
    const field = scanDocument(doc)[0] as ScannedField
    expect(field.optionTexts).toEqual(["大学专科", "大学本科（统招）"])
    const match = matchField(field)
    expect(match.semanticFieldId).toBe("basic.degree")
  })

  it("plan 仅含可归类字段，未知字段不进 confirm 列表", () => {
    const plan = planWith(fixtureDoc)
    for (const item of plan.items) {
      if (item.action === "manual") continue
      expect(item.match.semanticFieldId !== null || item.match.ambiguous).toBe(true)
    }
    // 未识别字段（兴趣爱好等）不产生条目
    const unknown = plan.items.find((i) => i.match.field.labelText === "兴趣爱好")
    expect(unknown).toBeUndefined()
  })
})

describe("T077 高置信直填：别名精确命中（仅控件形态不吻合）→ fill", () => {
  it("textarea「学校」精确命中（词表 controls 仅 text）→ gray + exact，计划直填", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="s1">学校</label><textarea id="s1" name="sch"></textarea></form>`,
      "text/html"
    )
    const field = scanDocument(doc)[0] as ScannedField
    const match = matchField(field)
    expect(match.semanticFieldId).toBe("basic.school")
    expect(match.confidence).toBe("gray")
    expect(match.exact).toBe(true)

    const plan = buildFillPlan([field], profile, entries)
    expect(plan.items[0]?.action).toBe("fill")
    expect(plan.items[0]?.value).toBe("清华大学")
  })

  it("radio「工作地点」精确命中（词表 controls 无 radio）+ 选项等价 → 直填", () => {
    const doc = new DOMParser().parseFromString(
      `<form><fieldset><legend>工作地点</legend>
        <label><input type="radio" name="city" value="北京" />北京</label>
        <label><input type="radio" name="city" value="上海" />上海</label>
      </fieldset></form>`,
      "text/html"
    )
    const field = scanDocument(doc)[0] as ScannedField
    const match = matchField(field)
    expect(match.semanticFieldId).toBe("intent.city")
    expect(match.confidence).toBe("gray")
    expect(match.exact).toBe(true)

    const plan = buildFillPlan([field], profile, entries)
    expect(plan.items[0]?.action).toBe("fill")
    expect(plan.items[0]?.value).toBe("北京")
  })

  it("exact 但选项措辞无等价项 → 仍先走确认（FR-013 拦截优先于直填）", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="deg9">最高学历</label>
        <select id="deg9" name="degree">
          <option value="">请选择</option>
          <option value="1">大学专科</option>
        </select></form>`,
      "text/html"
    )
    const field = scanDocument(doc)[0] as ScannedField
    expect(matchField(field).exact).toBe(true) // 别名精确命中
    const plan = buildFillPlan([field], profile, entries)
    expect(plan.items[0]?.action).toBe("confirm")
    expect(plan.items[0]?.reason).toContain("选项措辞")
  })

  it("label 仅部分包含（非精确）→ 不直填，仍进确认", () => {
    const doc = new DOMParser().parseFromString(
      `<form><label for="sl">学校简介</label><input id="sl" /></form>`,
      "text/html"
    )
    const field = scanDocument(doc)[0] as ScannedField
    const match = matchField(field)
    expect(match.semanticFieldId).toBe("basic.school")
    expect(match.exact).not.toBe(true)

    const plan = buildFillPlan([field], profile, entries)
    expect(plan.items[0]?.action).toBe("confirm")
    expect(plan.items[0]?.reason).toContain("部分包含")
  })
})
