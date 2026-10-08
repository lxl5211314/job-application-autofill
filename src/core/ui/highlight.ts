// T069: 填写现场反馈——滚动跟随到当前字段 + 黄色高亮（参考牛客交互，自研实现）
// 用 CSSOM 直接写行内 outline（不注入页面样式表，规避站点 CSP style-src）

interface SavedOutline {
  outline: string
  outlinePriority: string
  offset: string
  offsetPriority: string
  timer: ReturnType<typeof setTimeout> | null
}

const saved = new WeakMap<HTMLElement, SavedOutline>()
const HL_OUTLINE = "3px solid #f59e0b"

/** 滚动到目标字段视野中央并高亮 1.5s（多次调用刷新计时，恢复原行内样式） */
export function focusField(el: Element): void {
  if (!(el instanceof HTMLElement)) return

  if (typeof el.scrollIntoView === "function") {
    try {
      el.scrollIntoView({ block: "center", behavior: "smooth" })
    } catch {
      try {
        el.scrollIntoView()
      } catch {
        // jsdom/极老浏览器：忽略滚动，仅高亮
      }
    }
  }

  let state = saved.get(el)
  if (!state) {
    state = {
      outline: el.style.getPropertyValue("outline"),
      outlinePriority: el.style.getPropertyPriority("outline"),
      offset: el.style.getPropertyValue("outline-offset"),
      offsetPriority: el.style.getPropertyPriority("outline-offset"),
      timer: null
    }
    saved.set(el, state)
  } else if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }

  el.style.setProperty("outline", HL_OUTLINE, "important")
  el.style.setProperty("outline-offset", "2px", "important")

  state.timer = setTimeout(() => {
    restore(el, state as SavedOutline)
    saved.delete(el)
  }, 1500)
}

function restore(el: HTMLElement, state: SavedOutline): void {
  if (state.outline === "") el.style.removeProperty("outline")
  else el.style.setProperty("outline", state.outline, state.outlinePriority)
  if (state.offset === "") el.style.removeProperty("outline-offset")
  else el.style.setProperty("outline-offset", state.offset, state.offsetPriority)
  state.timer = null
}
