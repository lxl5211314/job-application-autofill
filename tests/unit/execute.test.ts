// T070: 计划执行器——进度累计（跨补扫轮）+ 暂停降级 + 失败归类 + 现场高亮

import { beforeEach, describe, expect, it, vi } from "vitest"

import { executeFills, type FillProgress } from "../../src/core/filling/execute"
import type { FillPlanItem } from "../../src/core/matching/match"
import type { ScannedField } from "../../src/core/matching/scan"

function makeField(label: string, opts: { prefilled?: boolean; value?: string } = {}): ScannedField {
  const input = document.createElement("input")
  input.type = "text"
  if (opts.value !== undefined) input.value = opts.value
  document.body.appendChild(input)
  return {
    element: input,
    controlKind: "text",
    labelText: label,
    nameIdPlaceholder: "",
    blockTitle: "",
    columnLabel: "",
    rowIndex: -1,
    prefilled: opts.prefilled ?? false,
    signature: `sig-${label}-${Math.random().toString(36).slice(2)}`
  }
}

function fillItem(label: string, value: string, opts?: { prefilled?: boolean; value?: string }): FillPlanItem {
  return {
    match: {
      field: makeField(label, opts),
      semanticFieldId: "basic.name",
      confidence: "high",
      candidates: [],
      ambiguous: false,
      conflict: false
    },
    action: "fill",
    value
  }
}

beforeEach(() => {
  document.body.innerHTML = ""
  vi.useFakeTimers()
})

describe("T070 executeFills 进度", () => {
  it("回调携带 done/total 与当前字段名；跨轮共享 counter 累计", async () => {
    const a = fillItem("姓名", "张三")
    const b = fillItem("邮箱", "a@b.com")
    const counter = { done: 0, total: 0 }
    const events: FillProgress[] = []

    await executeFills([a, b], { counter, isPaused: () => false, onProgress: (p) => events.push({ ...p }) })

    // 第一个回调：0/2 + 当前字段
    expect(events[0]).toMatchObject({ done: 0, total: 2 })
    expect(events[0]?.current).toBe("姓名")
    // 填完第一项 → 1/2
    expect(events.some((e) => e.done === 1 && e.total === 2)).toBe(true)
    expect(counter).toEqual({ done: 2, total: 2 })
    expect((a.match.field.element as HTMLInputElement).value).toBe("张三")

    // 第二轮（补扫）共享 counter → 累计 3/3
    const c = fillItem("手机", "13800000000")
    const round2: FillProgress[] = []
    await executeFills([c], { counter, isPaused: () => false, onProgress: (p) => round2.push({ ...p }) })
    expect(round2[0]?.done).toBe(2)
    expect(round2[round2.length - 1]).toMatchObject({ done: 3, total: 3 })
    expect(counter).toEqual({ done: 3, total: 3 })
  })

  it("计划里非 fill 项不计入 total", async () => {
    const fill = fillItem("姓名", "张三")
    const skip: FillPlanItem = { ...fillItem("备注", "x"), action: "skip", reason: "低置信" }
    const counter = { done: 0, total: 0 }
    await executeFills([fill, skip], { counter, isPaused: () => false })
    expect(counter.total).toBe(1)
    expect(skip.action).toBe("skip")
  })
})

describe("T070 暂停", () => {
  it("开填前已暂停：全部降级需人工，页面值不被触碰", async () => {
    const a = fillItem("姓名", "张三")
    const b = fillItem("邮箱", "a@b.com")
    const counter = { done: 0, total: 0 }

    await executeFills([a, b], { counter, isPaused: () => true })

    expect(a.action).toBe("manual")
    expect(a.reason).toContain("已暂停")
    expect(b.action).toBe("manual")
    expect((a.match.field.element as HTMLInputElement).value).toBe("")
    expect(counter.done).toBe(0)
    expect(counter.total).toBe(2)
  })

  it("填写中途暂停：已填保留，剩余降级需人工", async () => {
    const a = fillItem("姓名", "张三")
    const b = fillItem("邮箱", "a@b.com")
    const c = fillItem("手机", "13800000000")
    const counter = { done: 0, total: 0 }
    let paused = false

    await executeFills([a, b, c], {
      counter,
      isPaused: () => paused,
      onProgress: (p) => {
        if (p.done >= 1) paused = true
      }
    })

    expect(a.action).toBe("fill")
    expect((a.match.field.element as HTMLInputElement).value).toBe("张三")
    expect(b.action).toBe("manual")
    expect(b.reason).toContain("已暂停")
    expect(c.action).toBe("manual")
    expect((b.match.field.element as HTMLInputElement).value).toBe("")
    expect(counter.done).toBe(1)
    expect(counter.total).toBe(3)
  })
})

describe("T070 失败归类（自 autofill.ts 迁移）", () => {
  it("页面已有内容冲突 → confirm + FR-017 原因", async () => {
    const conflict = fillItem("姓名", "张三", { prefilled: true, value: "已存在" })
    const counter = { done: 0, total: 0 }
    await executeFills([conflict], { counter, isPaused: () => false })
    expect(conflict.action).toBe("confirm")
    expect(conflict.reason).toContain("FR-017")
    expect((conflict.match.field.element as HTMLInputElement).value).toBe("已存在")
  })

  it("widget 交互失败 → manual + 控件交互失败原因", async () => {
    // waitFor 轮询依赖真实时间（fake timers 会挂死），本用例切回真实计时器
    vi.useRealTimers()
    // 只读 + widget：execute 走 fillWidgetField；构造一个打不开弹层的 combobox
    const input = document.createElement("input")
    input.type = "text"
    document.body.appendChild(input)
    const field: ScannedField = {
      element: input,
      controlKind: "text",
      labelText: "学历",
      nameIdPlaceholder: "",
      blockTitle: "",
      columnLabel: "",
      rowIndex: -1,
      widget: "combobox",
      readOnly: true,
      prefilled: false,
      signature: "sig-widget-fail"
    } as ScannedField
    const item: FillPlanItem = {
      match: {
        field,
        semanticFieldId: "basic.edu",
        confidence: "high",
        candidates: [],
        ambiguous: false,
        conflict: false
      },
      action: "fill",
      value: "本科"
    }
    const counter = { done: 0, total: 0 }
    await executeFills([item], { counter, isPaused: () => false })
    expect(item.action).toBe("manual")
    expect(item.reason).toContain("控件交互失败")
    expect(counter.done).toBe(1)
  })
})

describe("T070 现场高亮", () => {
  it("填写前对目标字段施加黄色 outline", async () => {
    const a = fillItem("姓名", "张三")
    const counter = { done: 0, total: 0 }
    await executeFills([a], { counter, isPaused: () => false })
    const el = a.match.field.element as HTMLInputElement
    expect(el.style.getPropertyValue("outline")).toContain("#f59e0b")
    vi.advanceTimersByTime(1600)
    expect(el.style.getPropertyValue("outline")).toBe("")
  })
})
