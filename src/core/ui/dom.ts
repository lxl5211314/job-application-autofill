// T016: 原生 DOM 构建工具（无框架）

export type AttrValue = string | number | boolean | undefined | null | ((ev: Event) => void)

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  children: Array<Node | string | undefined | null> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (typeof value === "function") {
      const eventName = key.startsWith("on") ? key.slice(2).toLowerCase() : key
      node.addEventListener(eventName, value)
    } else if (key === "className") {
      node.className = String(value)
    } else {
      node.setAttribute(key, value === true ? "" : String(value))
    }
  }
  for (const child of children) {
    if (child === undefined || child === null) continue
    node.append(typeof child === "string" ? document.createTextNode(child) : child)
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function setText(node: Element, text: string): void {
  clear(node)
  node.append(document.createTextNode(text))
}
