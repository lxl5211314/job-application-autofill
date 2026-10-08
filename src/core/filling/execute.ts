// T070: 计划执行器——逐项填写 + 现场反馈（滚动高亮）+ 实时进度回调 + 暂停
// 从 contents/autofill.ts 抽出（P2）：进度/暂停在单测可覆盖，content 侧只做编排

import { planReportLabel, type FillPlanItem } from "../matching/match"
import { focusField } from "../ui/highlight"
import { fillField, type FillResult } from "./fill"
import { fillWidgetField } from "./widgets"

export interface FillProgress {
  done: number
  total: number
  /** 正在填写的字段名（fill 间隙调用回调时携带） */
  current?: string
}

/** 跨补扫轮累计的进度计数（挂在 ActiveSession 上，多轮 executeFills 共享） */
export interface ProgressCounter {
  done: number
  total: number
}

export interface ExecuteContext {
  counter: ProgressCounter
  /** 暂停标记实时读取（进度面板按钮在填写间隙置位） */
  isPaused: () => boolean
  /** 每次填写前后回调（渲染进度面板 / 转发 popup 进度事件） */
  onProgress?: (p: FillProgress) => void
}

export async function executeFills(
  items: FillPlanItem[],
  ctx: ExecuteContext
): Promise<void> {
  const targets = items.filter((i) => i.action === "fill" && i.value !== undefined)
  ctx.counter.total += targets.length

  const report = (current?: string): void => {
    ctx.onProgress?.({
      done: ctx.counter.done,
      total: ctx.counter.total,
      current
    })
  }

  for (const item of items) {
    if (item.action !== "fill" || item.value === undefined) continue

    // 暂停：剩余 fill 项降级「需人工」，不再触碰页面
    if (ctx.isPaused()) {
      item.action = "manual"
      item.reason = "已暂停（用户操作），未自动填写"
      continue
    }

    const field = item.match.field
    report(planReportLabel(item.match))
    focusField(field.element)

    const result: FillResult = field.widget
      ? await fillWidgetField(field, item.value)
      : fillField(field, item.value)

    ctx.counter.done += 1

    if (!result.filled) {
      item.action =
        result.reason === "blacklist" || result.reason === "widget"
          ? "manual"
          : result.reason === "conflict" || result.reason === "no_match"
            ? "confirm"
            : "missing"
      item.reason =
        result.reason === "conflict"
          ? "页面已有内容与资料库不一致，不覆盖（FR-017）"
          : result.reason === "no_match"
            ? "选项措辞与资料库不一致，不自动填"
            : result.reason === "blacklist"
              ? "非填写区控件，需人工处理"
              : result.reason === "widget"
                ? "控件交互失败（弹层未打开或未找到目标项），需人工处理"
                : `无法填写（${result.reason ?? "unknown"}）`
    }
    report()
  }
}
