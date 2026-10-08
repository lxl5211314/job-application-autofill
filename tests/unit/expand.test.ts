// T073/T074: div 型经历行按出现次序归组 + 多段经历自动展开（点「添加」按钮）
// 安全边界：黑名单不点 / 歧义容器不点 / 每类≤5 次 / 无增长即停 / 暂停不展开

import { beforeEach, describe, expect, it, vi } from "vitest"

import { expandEntryRows, findAddButtons } from "../../src/core/filling/expand"
import { buildFillPlan } from "../../src/core/matching/match"
import { scanDocument, scanReadonlyFields } from "../../src/core/matching/scan"
import type { ExperienceEntry, Profile } from "../../src/core/model/types"

const profile: Profile = { schemaVersion: 1, basics: {}, intent: {} }

function edu(id: string, title: string, order: number): ExperienceEntry {
  return {
    id,
    kind: "education",
    order,
    title,
    subtitle: "软件工程",
    state: "confirmed",
    source: "manual",
    updatedAt: 1
  }
}

function intern(id: string, title: string, order: number): ExperienceEntry {
  return { ...edu(id, title, order), kind: "internship" }
}

function planFor(doc: Document, entries: ExperienceEntry[]) {
  const fields = [...scanDocument(doc), ...scanReadonlyFields(doc)]
  return buildFillPlan(fields, profile, entries)
}

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("T073 div 型经历行归组（同 prop 出现次序 = 行号）", () => {
  it("两行 div 教育经历 → entryIndex 0/1 分别填对应条目", () => {
    document.body.innerHTML = `
      <h2>教育经历</h2>
      <div class="row"><label for="s1">学校名称</label><input id="s1" type="text"><label for="c1">专业</label><input id="c1" type="text"></div>
      <div class="row"><label for="s2">学校名称</label><input id="s2" type="text"><label for="c2">专业</label><input id="c2" type="text"></div>`

    const entries = [edu("e1", "清华大学", 0), edu("e2", "北京大学", 1)]
    const plan = planFor(document, entries)

    const row0 = plan.items.find(
      (i) => i.match.semanticFieldId === "entry.education.title" && i.entryIndex === 0
    )
    const row1 = plan.items.find(
      (i) => i.match.semanticFieldId === "entry.education.title" && i.entryIndex === 1
    )
    expect(row0?.action).toBe("fill")
    expect(row0?.value).toBe("清华大学")
    expect(row1?.action).toBe("fill")
    expect(row1?.value).toBe("北京大学")
    // 同 prop 多字段（专业）也按行归组
    const subs = plan.items
      .filter((i) => i.match.semanticFieldId === "entry.education.subtitle")
      .map((i) => i.entryIndex)
    expect(subs).toEqual([0, 1])
  })

  it("div 行数超过资料库 → 超出行为 missing（不乱填）", () => {
    document.body.innerHTML = `
      <h2>教育经历</h2>
      <div class="row"><label for="s1">学校名称</label><input id="s1" type="text"></div>
      <div class="row"><label for="s2">学校名称</label><input id="s2" type="text"></div>`

    const plan = planFor(document, [edu("e1", "清华大学", 0)])
    const row1 = plan.items.find(
      (i) => i.match.semanticFieldId === "entry.education.title" && i.entryIndex === 1
    )
    expect(row1?.action).toBe("missing")
  })
})

describe("T074 findAddButtons 词表", () => {
  it("只收添加类按钮；保存/删除/提交等黑名单即使带「添加」也不收", () => {
    document.body.innerHTML = `
      <button id="a1" type="button">+ 添加一段经历</button>
      <button id="a2" type="button">新增教育经历</button>
      <input id="a3" type="button" value="加一行">
      <button id="a4" type="button">添加并保存</button>
      <button id="a5" type="button">删除本行</button>
      <button id="a6" type="button">提交</button>
      <button id="a7" type="button">下一步</button>
      <button id="a8" type="button">保存</button>
      <button id="a9" type="button">上一步</button>`

    const found = findAddButtons(document).map((b) => b.id)
    expect(found).toEqual(["a1", "a2", "a3"])
  })
})

describe("T074 expandEntryRows 自动展开", () => {
  function sectionHtml(rows: number, withButton = true): string {
    let html = `<div id="sec"><h2>教育经历</h2>`
    for (let i = 1; i <= rows; i++) {
      html += `<div class="row"><label for="s${i}">学校名称</label><input id="s${i}" type="text"></div>`
    }
    if (withButton) html += `<button type="button" id="add">+ 添加一段经历</button>`
    return html + `</div>`
  }

  function attachAppender(buttonId: string): { clicks: number; rowCount: () => number } {
    const btn = document.getElementById(buttonId)
    let clicks = 0
    btn?.addEventListener("click", () => {
      clicks++
      const sec = document.getElementById("sec")!
      const n = sec.querySelectorAll("input").length + 1
      const row = document.createElement("div")
      row.className = "row"
      row.innerHTML = `<label for="s${n}">学校名称</label><input id="s${n}" type="text">`
      sec.insertBefore(row, btn)
    })
    return {
      get clicks() {
        return clicks
      },
      rowCount: () => document.querySelectorAll("#sec input").length
    }
  }

  const instantSleep = async (): Promise<void> => {}

  it("页面 1 行、资料 2 条 → 点一次添加，新行可按行号填入条目 2", async () => {
    document.body.innerHTML = sectionHtml(1)
    const appender = attachAppender("add")
    const entries = [edu("e1", "清华大学", 0), edu("e2", "北京大学", 1)]

    const res = await expandEntryRows({
      doc: document,
      profile,
      entries,
      sleep: instantSleep
    })

    expect(res.clicked).toBe(1)
    expect(res.addedByKind.education).toBe(1)
    expect(appender.rowCount()).toBe(2)

    // 展开后的行经全量计划可直接命中条目 2（补扫按元素去重，新元素即 fresh）
    const plan = planFor(document, entries)
    const row1 = plan.items.find(
      (i) => i.match.semanticFieldId === "entry.education.title" && i.entryIndex === 1
    )
    expect(row1?.action).toBe("fill")
    expect(row1?.value).toBe("北京大学")
  })

  it("资料条目不超页面行数 → 不点任何按钮", async () => {
    document.body.innerHTML = sectionHtml(2)
    const appender = attachAppender("add")
    const res = await expandEntryRows({
      doc: document,
      profile,
      entries: [edu("e1", "清华大学", 0), edu("e2", "北京大学", 1)],
      sleep: instantSleep
    })
    expect(res.clicked).toBe(0)
    expect(appender.clicks).toBe(0)
  })

  it("点了但行数不涨 → 停止且不计点击（有界轮询，不死转）", async () => {
    document.body.innerHTML = sectionHtml(1)
    // 按钮存在但点击无效
    let sleeps = 0
    const res = await expandEntryRows({
      doc: document,
      profile,
      entries: [edu("e1", "a", 0), edu("e2", "b", 1)],
      sleep: async () => {
        sleeps++
      }
    })
    expect(res.clicked).toBe(0)
    expect(sleeps).toBeLessThanOrEqual(11)
  }, 10000)

  it("每类最多 5 次点击（资料 10 条也只点 5 下）", async () => {
    document.body.innerHTML = sectionHtml(1)
    attachAppender("add")
    const entries = Array.from({ length: 10 }, (_, i) => edu(`e${i}`, `学校${i}`, i))
    const res = await expandEntryRows({ doc: document, profile, entries, sleep: instantSleep })
    expect(res.clicked).toBe(5)
    expect(res.addedByKind.education).toBe(5)
  })

  it("容器横跨两类经历（歧义）→ 不点", async () => {
    document.body.innerHTML = `
      <div id="sec">
        <h2>教育经历</h2>
        <div class="row"><label for="s1">学校名称</label><input id="s1" type="text"></div>
        <h2>实习经历</h2>
        <div class="row"><label for="i1">公司名称</label><input id="i1" type="text"></div>
        <button type="button" id="add">+ 添加</button>
      </div>`
    let clicks = 0
    document.getElementById("add")!.addEventListener("click", () => {
      clicks++
    })
    const entries = [
      edu("e1", "清华大学", 0),
      edu("e2", "北京大学", 1),
      intern("t1", "字节跳动", 0),
      intern("t2", "腾讯", 1)
    ]
    const res = await expandEntryRows({ doc: document, profile, entries, sleep: instantSleep })
    expect(res.clicked).toBe(0)
    expect(clicks).toBe(0)
  })

  it("分节容器各自归属：只扩教育节，满员的实习节按钮不被触发", async () => {
    document.body.innerHTML = `
      <div id="sec">
        <h2>教育经历</h2>
        <div class="row"><label for="s1">学校名称</label><input id="s1" type="text"></div>
        <button type="button" id="add-edu">+ 添加</button>
      </div>
      <div id="sec2">
        <h2>实习经历</h2>
        <div class="row"><label for="i1">公司名称</label><input id="i1" type="text"></div>
        <div class="row"><label for="i2">公司名称</label><input id="i2" type="text"></div>
        <button type="button" id="add-int">+ 添加</button>
      </div>`
    let eduClicks = 0
    let intClicks = 0
    document.getElementById("add-edu")!.addEventListener("click", () => {
      eduClicks++
      const n = document.querySelectorAll("#sec input").length + 1
      const row = document.createElement("div")
      row.className = "row"
      row.innerHTML = `<label for="s${n}">学校名称</label><input id="s${n}" type="text">`
      document.getElementById("sec")!.insertBefore(row, document.getElementById("add-edu"))
    })
    document.getElementById("add-int")!.addEventListener("click", () => {
      intClicks++
    })
    const entries = [
      edu("e1", "清华大学", 0),
      edu("e2", "北京大学", 1),
      intern("t1", "字节跳动", 0),
      intern("t2", "腾讯", 1)
    ]
    const res = await expandEntryRows({ doc: document, profile, entries, sleep: instantSleep })
    expect(res.addedByKind).toEqual({ education: 1 })
    expect(eduClicks).toBe(1)
    expect(intClicks).toBe(0)
  })

  it("会话已暂停 → 一个按钮都不点", async () => {
    document.body.innerHTML = sectionHtml(1)
    const appender = attachAppender("add")
    const res = await expandEntryRows({
      doc: document,
      profile,
      entries: [edu("e1", "a", 0), edu("e2", "b", 1)],
      isPaused: () => true,
      sleep: instantSleep
    })
    expect(res.clicked).toBe(0)
    expect(appender.clicks).toBe(0)
  })

  it("页面无「添加」按钮 → 静默跳过", async () => {
    document.body.innerHTML = sectionHtml(1, false)
    const res = await expandEntryRows({
      doc: document,
      profile,
      entries: [edu("e1", "a", 0), edu("e2", "b", 1)],
      sleep: instantSleep
    })
    expect(res.clicked).toBe(0)
    expect(res.addedByKind).toEqual({})
  })
})
