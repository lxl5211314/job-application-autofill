// T069: 填写现场反馈——滚动跟随 + 黄色高亮（CSSOM 行内样式，恢复原值）
// T078(P4): 未填标红——会话结束标红未填字段，确认面板点选成功后撤销

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  focusField,
  markUnfilled,
  markUnfilledItems,
  shouldMarkUnfilled,
  unmarkUnfilled
} from "../../src/core/ui/highlight"
import type { FillPlanItem } from "../../src/core/matching/match"

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ""
})

afterEach(() => {
  vi.useRealTimers()
})

describe("T069 focusField 滚动与高亮", () => {
  it("设置黄色 important outline，1500ms 后恢复原行内样式", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)

    focusField(input)
    expect(input.style.getPropertyValue("outline")).toContain("#f59e0b")
    expect(input.style.getPropertyPriority("outline")).toBe("important")

    vi.advanceTimersByTime(1600)
    expect(input.style.getPropertyValue("outline")).toBe("")
    expect(input.style.getPropertyValue("outline-offset")).toBe("")
  })

  it("恢复用户原有行内 outline（不吞页面样式）", () => {
    const input = document.createElement("input")
    input.style.setProperty("outline", "1px solid red")
    input.style.setProperty("outline-offset", "4px")
    document.body.appendChild(input)

    focusField(input)
    expect(input.style.getPropertyValue("outline")).toContain("#f59e0b")

    vi.advanceTimersByTime(1600)
    expect(input.style.getPropertyValue("outline")).toBe("1px solid red")
    expect(input.style.getPropertyValue("outline-offset")).toBe("4px")
  })

  it("重复调用刷新计时：窗口内再次高亮不会被旧计时器提前恢复", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)

    focusField(input)
    vi.advanceTimersByTime(1000)
    focusField(input)
    vi.advanceTimersByTime(1000)
    // 距第一次已 2000ms，但第二次才 1000ms → 仍在高亮
    expect(input.style.getPropertyValue("outline")).toContain("#f59e0b")

    vi.advanceTimersByTime(600)
    expect(input.style.getPropertyValue("outline")).toBe("")
  })

  it("jsdom 无 scrollIntoView 不抛错；存在时调用并居中滚动", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)

    // jsdom 默认没有 scrollIntoView
    expect(() => focusField(input)).not.toThrow()

    const spy = vi.fn()
    input.scrollIntoView = spy
    focusField(input)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }))
  })

  it("scrollIntoView 抛错（选项不被老引擎支持）时回退无参调用且不中断高亮", () => {
    const input = document.createElement("input")
    let calls = 0
    input.scrollIntoView = ((...args: unknown[]) => {
      calls++
      if (args.length > 0) throw new Error("bad options")
    }) as typeof input.scrollIntoView
    document.body.appendChild(input)

    expect(() => focusField(input)).not.toThrow()
    expect(calls).toBe(2)
    expect(input.style.getPropertyValue("outline")).toContain("#f59e0b")
  })

  it("非 HTMLElement（SVG）直接忽略", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    document.body.appendChild(svg)
    expect(() => focusField(svg)).not.toThrow()
  })
})

describe("T078 未填标红 markUnfilled/unmarkUnfilled", () => {
  it("标红设红色 important outline，unmark 恢复原状", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)

    markUnfilled(input)
    expect(input.style.getPropertyValue("outline")).toContain("#ef4444")
    expect(input.style.getPropertyPriority("outline")).toBe("important")

    unmarkUnfilled(input)
    expect(input.style.getPropertyValue("outline")).toBe("")
    expect(input.style.getPropertyValue("outline-offset")).toBe("")
  })

  it("保留用户原有行内 outline（unmark 后原样恢复）", () => {
    const input = document.createElement("input")
    input.style.setProperty("outline", "1px solid blue")
    document.body.appendChild(input)

    markUnfilled(input)
    expect(input.style.getPropertyValue("outline")).toContain("#ef4444")
    unmarkUnfilled(input)
    expect(input.style.getPropertyValue("outline")).toBe("1px solid blue")
  })

  it("幂等：重复标红后 unmark 一次即恢复原状（不残留红/黄）", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)

    markUnfilled(input)
    markUnfilled(input)
    unmarkUnfilled(input)
    expect(input.style.getPropertyValue("outline")).toBe("")
    // unmark 第二次无操作
    unmarkUnfilled(input)
    expect(input.style.getPropertyValue("outline")).toBe("")
  })

  it("黄色高亮计时未结束时标红：清掉旧计时，红框不会被恢复回调抹掉", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)

    focusField(input) // 黄色高亮启动（1500ms 计时）
    markUnfilled(input) // 立即标红（会先还原黄并清计时）
    expect(input.style.getPropertyValue("outline")).toContain("#ef4444")

    vi.advanceTimersByTime(3000) // 旧计时器若未清除会把红框覆盖回原值
    expect(input.style.getPropertyValue("outline")).toContain("#ef4444")

    unmarkUnfilled(input)
    expect(input.style.getPropertyValue("outline")).toBe("")
  })

  it("标红后再 focusField：黄框恢复后红标仍在（saved 恢复的是红框原值）", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)

    markUnfilled(input)
    focusField(input)
    expect(input.style.getPropertyValue("outline")).toContain("#f59e0b")
    vi.advanceTimersByTime(1600)
    expect(input.style.getPropertyValue("outline")).toContain("#ef4444")

    unmarkUnfilled(input)
    expect(input.style.getPropertyValue("outline")).toBe("")
  })

  it("非 HTMLElement 忽略；未标过的元素 unmark 无操作", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    document.body.appendChild(svg)
    expect(() => markUnfilled(svg)).not.toThrow()
    expect(() => unmarkUnfilled(svg)).not.toThrow()

    const input = document.createElement("input")
    document.body.appendChild(input)
    expect(() => unmarkUnfilled(input)).not.toThrow()
    expect(input.style.getPropertyValue("outline")).toBe("")
  })
})

describe("T078 shouldMarkUnfilled 过滤规则", () => {
  function itemOf(over: { action?: FillPlanItem["action"]; reason?: string }): FillPlanItem {
    return {
      match: {
        field: { element: document.createElement("input") } as never,
        semanticFieldId: "basic.name",
        confidence: "gray",
        candidates: [],
        ambiguous: false,
        conflict: false
      },
      action: over.action ?? "confirm",
      reason: over.reason
    }
  }

  it("confirm / missing → 标红", () => {
    expect(shouldMarkUnfilled(itemOf({ action: "confirm" }))).toBe(true)
    expect(shouldMarkUnfilled(itemOf({ action: "missing" }))).toBe(true)
  })

  it("manual 中「只读 / 交互失败 / 已暂停」→ 标红", () => {
    expect(
      shouldMarkUnfilled(itemOf({ action: "manual", reason: "只读控件（需在页面弹层中选择），不自动填写" }))
    ).toBe(true)
    expect(
      shouldMarkUnfilled(itemOf({ action: "manual", reason: "控件交互失败（弹层未打开或未找到目标项），需人工处理" }))
    ).toBe(true)
    expect(shouldMarkUnfilled(itemOf({ action: "manual", reason: "已暂停（用户操作），未自动填写" }))).toBe(true)
  })

  it("manual 非填写区黑名单（密码/提交）→ 不标（刻意跳过，非噪音）", () => {
    expect(shouldMarkUnfilled(itemOf({ action: "manual", reason: "非填写区（password），需人工处理" }))).toBe(false)
    expect(shouldMarkUnfilled(itemOf({ action: "manual", reason: "非填写区控件，需人工处理" }))).toBe(false)
  })

  it("已填 fill / 弱信号 skip → 不标", () => {
    expect(shouldMarkUnfilled(itemOf({ action: "fill" }))).toBe(false)
    expect(shouldMarkUnfilled(itemOf({ action: "skip", reason: "仅 name/id 弱信号命中，置信不足未填写" }))).toBe(false)
  })
})

describe("T078 markUnfilledItems 批量标红", () => {
  it("只标应标的元素（confirm 红、fill 原状），幂等可重复调用", () => {
    const mk = (action: FillPlanItem["action"], reason?: string): [FillPlanItem, HTMLInputElement] => {
      const el = document.createElement("input")
      document.body.appendChild(el)
      return [
        {
          match: {
            field: { element: el } as never,
            semanticFieldId: "basic.name",
            confidence: "gray",
            candidates: [],
            ambiguous: false,
            conflict: false
          },
          action,
          reason
        },
        el
      ]
    }
    const [confirmItem, confirmEl] = mk("confirm", "歧义字段")
    const [fillItem, fillEl] = mk("fill")
    const [blackItem, blackEl] = mk("manual", "非填写区（password），需人工处理")

    markUnfilledItems([confirmItem, fillItem, blackItem])
    expect(confirmEl.style.getPropertyValue("outline")).toContain("#ef4444")
    expect(fillEl.style.getPropertyValue("outline")).toBe("")
    expect(blackEl.style.getPropertyValue("outline")).toBe("")

    // 幂等：再标一次不改变原值结构，unmark 后恢复干净
    markUnfilledItems([confirmItem, fillItem, blackItem])
    unmarkUnfilled(confirmEl)
    expect(confirmEl.style.getPropertyValue("outline")).toBe("")
  })
})
