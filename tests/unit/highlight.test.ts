// T069: 填写现场反馈——滚动跟随 + 黄色高亮（CSSOM 行内样式，恢复原值）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { focusField } from "../../src/core/ui/highlight"

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
