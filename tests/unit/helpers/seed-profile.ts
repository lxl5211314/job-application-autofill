// T026: 资料库夹具加载（US1 独立验收用，不依赖 US2 的 UI）

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { ExperienceEntry, Profile } from "../../../src/core/model/types"
import { emptyProfile } from "../../../src/core/model/types"

// jsdom 环境下全局 URL 是 DOM 实现，无法传给 readFileSync → 用 cwd 解析
const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures")

interface ProfileFixture {
  profile: Profile
  entries: ExperienceEntry[]
}

export function loadProfileFixture(): ProfileFixture {
  const raw = readFileSync(join(FIXTURE_DIR, "profile.fixture.json"), "utf8")
  const data = JSON.parse(raw) as ProfileFixture
  return {
    profile: { ...emptyProfile(), ...data.profile },
    entries: data.entries
  }
}

export function loadFixtureHtml(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
}

/** 解析夹具 HTML 为独立 Document（不执行脚本） */
export function parseFixture(name: string): Document {
  const html = loadFixtureHtml(name)
  return new DOMParser().parseFromString(html, "text/html")
}
