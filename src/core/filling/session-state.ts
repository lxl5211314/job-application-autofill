// T023: 填写会话共享状态（content 与结果/确认面板之间传递）
// 面板（US3 确认交互）通过 getActiveSession() 取回计划项与字段引用

import type {
  ExperienceEntry,
  FieldMemory,
  FillReport,
  FillReportItem,
  Profile
} from "../model/types"
import type { FillPlanItem } from "../matching/match"

export interface ActiveSession {
  sessionId: string
  reportId: string
  startedAt: number
  profile: Profile
  entries: ExperienceEntry[]
  memoryBySig: Map<string, FieldMemory>
  /** signature → 计划项（确认面板 pick/skip 回填用） */
  itemsBySig: Map<string, FillPlanItem>
  /** 全部计划项（含补扫），按执行顺序 */
  executed: FillPlanItem[]
  /** 已在确认面板处理过的条目（pick/skip 后不再显示） */
  resolved: Set<FillPlanItem>
  reportItems: FillReportItem[]
  /** 最终报告（reportItems 与其 items 为同一数组引用） */
  report: FillReport | null
  coveredIds: Set<string>
}

let active: ActiveSession | null = null

export function setActiveSession(session: ActiveSession | null): void {
  active = session
}

export function getActiveSession(): ActiveSession | null {
  return active
}
