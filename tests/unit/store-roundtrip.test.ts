// T031: 持久化往返（FR-004）：保存 → 重开（重新读取）→ 数据完整
// 顺带覆盖 migrate / ensureSchema 幂等（S7）

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as store from "../../src/core/storage/store"
import { emptyProfile, type ExperienceEntry, type Profile } from "../../src/core/model/types"
import { installFakeChrome, type FakeChromeHandle } from "./helpers/fake-chrome"

let fake: FakeChromeHandle

beforeEach(() => {
  fake = installFakeChrome()
})

afterEach(() => {
  fake.uninstall()
})

function sampleProfile(): Profile {
  const p = emptyProfile()
  p.basics["basic.name"] = { value: "张三", state: "confirmed", source: "manual", updatedAt: 1 }
  p.basics["basic.phone"] = { value: "13800138000", state: "confirmed", source: "manual", updatedAt: 1 }
  p.intent["intent.city"] = { value: "上海", state: "needs_review", source: "manual", updatedAt: 1 }
  return p
}

function sampleEntries(): ExperienceEntry[] {
  return [
    {
      id: "e1",
      kind: "education",
      order: 0,
      title: "某某大学",
      subtitle: "计算机科学",
      start: "2020.09",
      end: "2024.06",
      state: "confirmed",
      source: "manual",
      updatedAt: 1
    }
  ]
}

describe("profile 持久化往返", () => {
  it("保存后重新读取内容一致（模拟关闭/重开 options 页）", async () => {
    await store.saveProfile(sampleProfile())
    await store.saveEntries(sampleEntries())

    // 重新读取 = 重开页面
    const profile = await store.getProfile()
    const entries = await store.getEntries()

    expect(profile.basics["basic.name"]?.value).toBe("张三")
    expect(profile.basics["basic.phone"]?.value).toBe("13800138000")
    expect(profile.intent["intent.city"]?.value).toBe("上海")
    expect(profile.intent["intent.city"]?.state).toBe("needs_review")
    expect(entries).toHaveLength(1)
    expect(entries[0]?.title).toBe("某某大学")
    expect(entries[0]?.start).toBe("2020.09")
  })

  it("修改手机号后读到新值（S1：改值→一键填写取新值的前提）", async () => {
    await store.saveProfile(sampleProfile())
    const p = await store.getProfile()
    p.basics["basic.phone"] = { value: "19900001111", state: "confirmed", source: "manual", updatedAt: 2 }
    await store.saveProfile(p)

    const again = await store.getProfile()
    expect(again.basics["basic.phone"]?.value).toBe("19900001111")
    expect(again.basics["basic.name"]?.value).toBe("张三")
  })

  it("校验失败抛 ValidationError 且不写入", async () => {
    const p = sampleProfile()
    p.basics["basic.phone"] = { value: "123", state: "confirmed", source: "manual", updatedAt: 1 }
    await expect(store.saveProfile(p)).rejects.toMatchObject({
      details: { "basic.phone": expect.stringContaining("手机号") }
    })

    // 旧值仍在
    const stored = await store.getProfile()
    expect(stored.basics["basic.phone"]).toBeUndefined()
  })

  it("空库读取返回默认结构（不抛错）", async () => {
    expect(await store.getProfile()).toEqual(emptyProfile())
    expect(await store.getEntries()).toEqual([])
  })
})

describe("migrate", () => {
  it("v0 快照补全为 v1（S7 可执行）", () => {
    const migrated = store.migrate({})
    expect(migrated["schemaVersion"]).toBe(1)
    expect(migrated["profile"]).toEqual(emptyProfile())
    expect(migrated["entries"]).toEqual([])
    expect(migrated["fieldMemory"]).toEqual([])
    expect(migrated["fillReports"]).toEqual([])
  })

  it("已迁移快照幂等", () => {
    const once = store.migrate({})
    const twice = store.migrate(once)
    expect(twice).toEqual(once)
  })

  it("ensureSchema 幂等且可被再次读取", async () => {
    await store.ensureSchema()
    await store.ensureSchema()
    expect(await store.getProfile()).toEqual(emptyProfile())
  })
})
