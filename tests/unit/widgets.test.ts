// T065-T068: 交互控件驱动（自定义下拉 / 日历面板 / 级联 select 兜底）
// 模拟框架行为：click → 同步挂载弹层 → 点选项回填（jsdom 内纯 DOM 手写，不依赖真实框架）

import { beforeEach, describe, expect, it } from "vitest"

import { fillField } from "../../src/core/filling/fill"
import { fillWidgetField } from "../../src/core/filling/widgets"
import { buildFillPlan } from "../../src/core/matching/match"
import { scanDocument, scanReadonlyFields, type ScannedField } from "../../src/core/matching/scan"
import { dateEquivalent, dateParts, toIsoDate } from "../../src/core/model/date"
import type { Profile } from "../../src/core/model/types"

function profileWith(basics: Record<string, string>): Profile {
  const p: Profile = { schemaVersion: 1, basics: {}, intent: {} }
  for (const [id, value] of Object.entries(basics)) {
    const field = { value, state: "confirmed" as const, source: "manual" as const, updatedAt: 0 }
    if (id.startsWith("intent.")) {
      p.intent[id as keyof Profile["intent"]] = field
    } else {
      p.basics[id as keyof Profile["basics"]] = field
    }
  }
  return p
}

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("T065 日期归一化（model/date）", () => {
  it("自由文本 → ISO（缺日补 1 号；无法识别返回 null）", () => {
    expect(toIsoDate("1999-09-01")).toBe("1999-09-01")
    expect(toIsoDate("1999/9/1")).toBe("1999-09-01")
    expect(toIsoDate("1999年9月1日")).toBe("1999-09-01")
    expect(toIsoDate("1999年9月")).toBe("1999-09-01")
    expect(toIsoDate("hello")).toBeNull()
    expect(toIsoDate("")).toBeNull()
  })

  it("日期等价：格式无关；缺日宽恕；日不同不等价", () => {
    expect(dateEquivalent("1999-09-01", "1999/9/1")).toBe(true)
    expect(dateEquivalent("1999年9月1日", "1999-09-01")).toBe(true)
    expect(dateEquivalent("1999年9月", "1999-09-01")).toBe(true)
    expect(dateEquivalent("1999-09-01", "1999-09-02")).toBe(false)
    expect(dateEquivalent("1999-09-01", "2000-09-01")).toBe(false)
    expect(dateEquivalent("不是日期", "1999-09-01")).toBe(false)
  })

  it("dateParts 不误吞非日期数字串", () => {
    expect(dateParts("15000-20000")).toBeNull()
    expect(dateParts("1999")).toBeNull()
    expect(dateParts("1999年9月")).toEqual({ y: 1999, m: 9 })
  })
})

describe("T066 自定义下拉（div[role=combobox]）", () => {
  function setupTrigger(): { doc: Document; trigger: HTMLElement; field: ScannedField } {
    document.body.innerHTML = `
      <div class="form-item"><label for="deg">学历</label>
        <div role="combobox" id="deg" class="my-select" aria-haspopup="listbox" aria-expanded="false">
          <span class="placeholder">请选择</span>
        </div>
      </div>`
    const fields = scanDocument(document)
    const field = fields.find((f) => f.labelText === "学历")
    if (!field) throw new Error("学历字段未扫到")
    const trigger = document.getElementById("deg") as HTMLElement

    // 模拟框架：点击触发器挂载 listbox；点选项回显并关闭
    let listbox: HTMLElement | null = null
    trigger.addEventListener("click", () => {
      if (listbox) return
      listbox = document.createElement("ul")
      listbox.setAttribute("role", "listbox")
      for (const t of ["专科", "本科", "硕士"]) {
        const li = document.createElement("li")
        li.textContent = t
        li.addEventListener("click", () => {
          trigger.innerHTML = `<span>${t}</span>`
          listbox?.remove()
          listbox = null
        })
        listbox.append(li)
      }
      document.body.append(listbox)
    })
    return { doc: document, trigger, field }
  }

  it("扫描：label[for] 命中、controlKind=select、widget=combobox、占位不算预填", () => {
    const { field } = setupTrigger()
    expect(field.labelText).toBe("学历")
    expect(field.controlKind).toBe("select")
    expect(field.widget).toBe("combobox")
    expect(field.prefilled).toBe(false)
    expect(field.manual).toBeUndefined()
  })

  it("计划：精确标签 + 控件吻合 → 高置信 fill", () => {
    const { field } = setupTrigger()
    const plan = buildFillPlan(
      [field],
      profileWith({ "basic.degree": "硕士" }),
      []
    )
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]?.action).toBe("fill")
    expect(plan.items[0]?.value).toBe("硕士")
  })

  it("驱动：点击打开 → 选项等价匹配 → 点选回填", async () => {
    const { field, trigger } = setupTrigger()
    const result = await fillWidgetField(field, "硕士")
    expect(result.filled).toBe(true)
    expect(result.appliedValue).toBe("硕士")
    expect(trigger.textContent).toBe("硕士")
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it("驱动：已回显等价值 → 不点开面板直接成功", async () => {
    const { field, trigger } = setupTrigger()
    trigger.innerHTML = `<span>本科</span>`
    const result = await fillWidgetField(field, "本科")
    expect(result.filled).toBe(true)
    expect(result.appliedValue).toBe("本科")
  })

  it("驱动：选项措辞不一致 → no_match（计划侧归「需确认」）", async () => {
    const { field } = setupTrigger()
    const result = await fillWidgetField(field, "博士")
    expect(result.filled).toBe(false)
    expect(result.reason).toBe("no_match")
  })

  it("驱动：点不开弹层 → reason=widget（执行期降级「需人工」）", async () => {
    document.body.innerHTML = `
      <div class="form-item"><label for="deg2">学历</label>
        <div role="combobox" id="deg2"><span class="placeholder">请选择</span></div>
      </div>`
    const field = scanDocument(document).find((f) => f.labelText === "学历")
    expect(field?.widget).toBe("combobox")
    const result = await fillWidgetField(field as ScannedField, "硕士")
    expect(result.filled).toBe(false)
    expect(result.reason).toBe("widget")
  }, 3000)
})

describe("T067 只读日历面板（readonly date input）", () => {
  function setupReadonlyDate(): { input: HTMLInputElement; field: ScannedField } {
    document.body.innerHTML = `
      <form><label for="bd">出生日期</label><input id="bd" readonly /></form>`
    const field = scanReadonlyFields(document).find((f) => f.labelText === "出生日期")
    if (!field) throw new Error("出生日期字段未扫到")
    const input = document.getElementById("bd") as HTMLInputElement

    // 模拟框架：点击输入框弹出日历；点 td[title] 回填并关闭
    let panel: HTMLElement | null = null
    input.addEventListener("click", () => {
      if (panel) return
      panel = document.createElement("div")
      panel.className = "x-calendar"
      panel.innerHTML = `<table><tr>
        <td title="1999-09-01">1</td><td title="1999-09-02">2</td><td title="1999-09-03">3</td>
      </tr></table>`
      panel.querySelector('[title="1999-09-01"]')?.addEventListener("click", () => {
        input.value = "1999-09-01"
        panel?.remove()
        panel = null
      })
      document.body.append(panel)
    })
    return { input, field }
  }

  it("扫描：日期语义只读输入标 widget=date（manual 仍为 readonly）", () => {
    const { field } = setupReadonlyDate()
    expect(field.manual).toBe("readonly")
    expect(field.widget).toBe("date")
    expect(field.signature.endsWith("|ro")).toBe(true)
  })

  it("计划：可驱动 → fill（而非 T057 的 manual）", () => {
    const { field } = setupReadonlyDate()
    const plan = buildFillPlan([field], profileWith({ "basic.birthday": "1999-09-01" }), [])
    expect(plan.items[0]?.action).toBe("fill")
  })

  it("驱动：打开面板 → td[title] 直选 → 回读校验", async () => {
    const { field, input } = setupReadonlyDate()
    const result = await fillWidgetField(field, "1999-09-01")
    expect(result.filled).toBe(true)
    expect(input.value).toBe("1999-09-01")
  })

  it("驱动：已回显等价日期 → 不点开面板直接成功（点开也没关面板的场景不误伤）", async () => {
    const { field, input } = setupReadonlyDate()
    input.value = "1999/9/1"
    const result = await fillWidgetField(field, "1999-09-01")
    expect(result.filled).toBe(true)
    expect(result.appliedValue).toBe("1999/9/1")
  })

  it("驱动：打不开面板 → reason=widget（执行期降级「需人工」）", async () => {
    document.body.innerHTML = `<form><label for="bd2">出生日期</label><input id="bd2" readonly /></form>`
    const field = scanReadonlyFields(document).find((f) => f.labelText === "出生日期")
    const result = await fillWidgetField(field as ScannedField, "1999-09-01")
    expect(result.filled).toBe(false)
    expect(result.reason).toBe("widget")
  }, 3000)

  it("无日期/下拉迹象的只读 → 不标 widget（T057 manual 路径保留）", () => {
    document.body.innerHTML = `<form><label for="deg3">学历</label><input id="deg3" value="本科" readonly /></form>`
    const field = scanReadonlyFields(document).find((f) => f.labelText === "学历")
    expect(field?.widget).toBeUndefined()
    const plan = buildFillPlan([field as ScannedField], profileWith({ "basic.degree": "硕士" }), [])
    expect(plan.items[0]?.action).toBe("manual")
    expect(plan.items[0]?.reason).toContain("只读")
  })

  it("「请选择…」占位的只读输入 → 标 widget=combobox", () => {
    document.body.innerHTML = `<form><label for="deg4">学历</label><input id="deg4" placeholder="请选择学历" readonly /></form>`
    const field = scanReadonlyFields(document).find((f) => f.labelText === "学历")
    expect(field?.widget).toBe("combobox")
  })
})

describe("T068 级联 select 与日期冲突兜底", () => {
  it("级联子 select：扫描后 options 被父级重建，plan+fill 用实时 options 命中", () => {
    document.body.innerHTML = `
      <select id="prov"><option value="">请选择</option><option value="bj">北京</option></select>
      <label for="city">意向城市</label>
      <select id="city"><option value="">请选择</option></select>`
    const field = scanDocument(document).find((f) => f.labelText === "意向城市")
    expect(field).toBeTruthy()

    // 模拟选省后框架重建市选项（扫描快照 optionTexts 已过期）
    const city = document.getElementById("city") as HTMLSelectElement
    city.innerHTML = `<option value="">请选择</option><option value="bjs">北京</option>`

    const plan = buildFillPlan([field as ScannedField], profileWith({ "intent.city": "北京" }), [])
    expect(plan.items[0]?.action).toBe("fill")

    const result = fillField(field as ScannedField, "北京")
    expect(result.filled).toBe(true)
    expect(city.value).toBe("bjs")
  })

  it("页面预填 1999/9/1 与资料 1999-09-01 日期等价 → fill 不误报冲突", () => {
    document.body.innerHTML = `<form><label for="bdf">出生日期</label><input id="bdf" value="1999/9/1" /></form>`
    const field = scanDocument(document).find((f) => f.labelText === "出生日期")
    const plan = buildFillPlan([field as ScannedField], profileWith({ "basic.birthday": "1999-09-01" }), [])
    expect(plan.items[0]?.action).toBe("fill")
  })

  it("input[type=date]：自由文本资料值归一化为 ISO 写入", () => {
    document.body.innerHTML = `<form><label for="dt">出生日期</label><input id="dt" type="date" /></form>`
    const field = scanDocument(document).find((f) => f.labelText === "出生日期")
    expect(field?.widget).toBeUndefined() // 原生可编辑 date 走 fillField，无需 widget
    const result = fillField(field as ScannedField, "1999年9月1日")
    expect(result.filled).toBe(true)
    expect(result.appliedValue).toBe("1999-09-01")
    expect((document.getElementById("dt") as HTMLInputElement).value).toBe("1999-09-01")
  })
})
