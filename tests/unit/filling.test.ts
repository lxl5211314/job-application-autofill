// T018: 填充器单元测试（原生 setter+事件派发、select/radio/checkbox、黑名单，FR-018/017）

import { describe, expect, it } from "vitest"

import { fillField } from "../../src/core/filling/fill"
import { scanDocument, type ScannedField } from "../../src/core/matching/scan"

function scanHtml(html: string): ScannedField[] {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body><form>${html}</form></body></html>`, "text/html")
  return scanDocument(doc)
}

function track(el: Element): Record<string, number> {
  const counts: Record<string, number> = { input: 0, change: 0, blur: 0 }
  for (const type of Object.keys(counts)) {
    el.addEventListener(type, () => {
      counts[type] = (counts[type] ?? 0) + 1
    })
  }
  return counts
}

describe("fillField 文本类（原生 setter + 事件派发）", () => {
  it("input：写入值并派发 input/change/blur", () => {
    const [field] = scanHtml('<label for="a">姓名</label><input id="a" name="a" type="text" />')
    const f = field as ScannedField
    const counts = track(f.element)
    const result = fillField(f, "张三")
    expect(result.filled).toBe(true)
    expect((f.element as HTMLInputElement).value).toBe("张三")
    expect(counts.input).toBe(1)
    expect(counts.change).toBe(1)
    expect(counts.blur).toBe(1)
  })

  it("textarea：写入值并派发事件", () => {
    const [field] = scanHtml('<label for="t">兴趣爱好</label><textarea id="t" name="t"></textarea>')
    const f = field as ScannedField
    const counts = track(f.element)
    const result = fillField(f, "登山")
    expect(result.filled).toBe(true)
    expect((f.element as HTMLTextAreaElement).value).toBe("登山")
    expect(counts.change).toBe(1)
  })

  it("页面预填且不一致 → 不覆盖（FR-017），allowConflict 后可覆盖", () => {
    const [field] = scanHtml(
      '<label for="p">联系电话</label><input id="p" name="p" type="tel" value="010-12345678" />'
    )
    const f = field as ScannedField
    const result = fillField(f, "13812345678")
    expect(result.filled).toBe(false)
    expect(result.reason).toBe("conflict")
    expect((f.element as HTMLInputElement).value).toBe("010-12345678")

    const forced = fillField(f, "13812345678", { allowConflict: true })
    expect(forced.filled).toBe(true)
    expect((f.element as HTMLInputElement).value).toBe("13812345678")
  })

  it("预填值与目标一致 → 视为可填（幂等）", () => {
    const [field] = scanHtml(
      '<label for="p">手机号码</label><input id="p" name="p" type="tel" value="13812345678" />'
    )
    const f = field as ScannedField
    const result = fillField(f, "138 1234 5678")
    expect(result.filled).toBe(true)
  })
})

describe("fillField 选项类", () => {
  it("select：选项等价映射（本科 ↔ 大学本科）", () => {
    const [field] = scanHtml(`
      <label for="d">最高学历</label>
      <select id="d" name="d">
        <option value="">请选择</option>
        <option value="c">大学专科</option>
        <option value="b">大学本科</option>
        <option value="m">硕士研究生</option>
      </select>`)
    const f = field as ScannedField
    const counts = track(f.element)
    const result = fillField(f, "本科")
    expect(result.filled).toBe(true)
    expect(result.appliedValue).toBe("大学本科")
    expect((f.element as HTMLSelectElement).value).toBe("b")
    expect(counts.change).toBe(1)
  })

  it("select：无等价选项 → no_match（转确认面板）", () => {
    const [field] = scanHtml(`
      <label for="d">学历要求</label>
      <select id="d" name="d">
        <option value="">请选择</option>
        <option value="x">本科及以上（含专升本）</option>
      </select>`)
    const f = field as ScannedField
    const result = fillField(f, "硕士")
    expect(result.filled).toBe(false)
    expect(result.reason).toBe("no_match")
  })

  it("radio 组：点击目标单选并派发事件", () => {
    const [field] = scanHtml(`
      <fieldset>
        <legend>政治面貌</legend>
        <label><input type="radio" name="p" value="中共党员" />中共党员</label>
        <label><input type="radio" name="p" value="共青团员" />共青团员</label>
        <label><input type="radio" name="p" value="群众" />群众</label>
      </fieldset>`)
    const f = field as ScannedField
    const counts = track(f.element)
    const result = fillField(f, "共青团员")
    expect(result.filled).toBe(true)
    const group = f.radioGroup ?? [f.element as HTMLInputElement]
    expect(group[1]?.checked).toBe(true)
    expect(group[0]?.checked).toBe(false)
    expect(counts.change).toBeGreaterThanOrEqual(1)
  })

  it("checkbox：真值 → 勾选", () => {
    const [field] = scanHtml('<label><input type="checkbox" id="opt" name="opt" />订阅通知</label>')
    const f = field as ScannedField
    const result = fillField(f, "是")
    expect(result.filled).toBe(true)
    expect((f.element as HTMLInputElement).checked).toBe(true)
  })
})

describe("fillField 黑名单与不可交互（FR-018/019）", () => {
  it("密码/上传/提交/验证码/条款 → blacklist 跳过", () => {
    const fields = scanHtml(`
      <label for="pw">登录密码</label><input id="pw" type="password" />
      <label for="fi">上传简历</label><input id="fi" type="file" />
      <label for="cv">验证码</label><input id="cv" name="cv" />
      <label><input type="checkbox" id="ag" />我已阅读并同意《协议》</label>
      <button type="submit">提交简历</button>
    `)
    for (const f of fields) {
      const result = fillField(f, "任意值")
      expect(result.filled, f.labelText).toBe(false)
      expect(result.reason, f.labelText).toBe("blacklist")
    }
  })

  it("readonly → readonly 跳过；disabled → disabled 跳过", () => {
    const ro = document.createElement("input")
    ro.setAttribute("readonly", "")
    ro.value = "locked"
    const roField: ScannedField = {
      element: ro,
      controlKind: "text",
      labelText: "姓名",
      nameIdPlaceholder: "n",
      blockTitle: "",
      columnLabel: "",
      rowIndex: -1,
      prefilled: true,
      signature: "s-ro"
    }
    expect(fillField(roField, "张三").reason).toBe("readonly")

    const dis = document.createElement("input")
    dis.disabled = true
    const disField: ScannedField = { ...roField, element: dis, prefilled: false, signature: "s-dis" }
    expect(fillField(disField, "张三").reason).toBe("disabled")
  })
})
