// T016: Shadow-DOM 页内面板宿主（research R2：隔离站点样式）

import panelCss from "data-text:../../styles/panel.css"

export interface PanelHandle {
  host: HTMLElement
  shadow: ShadowRoot
  root: HTMLElement
  destroy: () => void
}

const mounted = new Map<string, PanelHandle>()

/** 创建（或复用）固定于页面右下角的 Shadow DOM 面板 */
export function createPanel(id: string): PanelHandle {
  const existing = mounted.get(id)
  if (existing && document.body.contains(existing.host)) return existing

  const host = document.createElement("div")
  host.id = `job-autofill-${id}`
  host.style.all = "initial"
  host.style.position = "fixed"
  host.style.zIndex = "2147483645"

  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = panelCss
  const root = document.createElement("div")
  root.className = "panel-root"
  shadow.append(style, root)

  ;(document.body || document.documentElement).appendChild(host)

  const handle: PanelHandle = {
    host,
    shadow,
    root,
    destroy: () => {
      host.remove()
      mounted.delete(id)
    }
  }
  mounted.set(id, handle)
  return handle
}

export function getPanel(id: string): PanelHandle | null {
  const existing = mounted.get(id)
  if (existing && document.body.contains(existing.host)) return existing
  mounted.delete(id)
  return null
}

export function destroyPanel(id: string): void {
  mounted.get(id)?.destroy()
}
