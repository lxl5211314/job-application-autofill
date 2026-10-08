// 测试用 chrome.storage.local 内存实现（S7 存储迁移/LRU 测试）

export type FakeMessageListener = (
  request: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean | void

export interface FakeChromeHandle {
  data: Record<string, unknown>
  /** chrome.runtime.onMessage 捕获的监听器（供 background 路由测试） */
  listeners: FakeMessageListener[]
  /** chrome.runtime.onConnect 捕获的监听器（T071 进度端口） */
  connectListeners: Array<(port: unknown) => void>
  uninstall: () => void
}

function normalizeKeys(
  data: Record<string, unknown>,
  keys: null | string | string[] | Record<string, unknown>
): Record<string, unknown> {
  if (keys === null || keys === undefined) return { ...data }
  if (typeof keys === "string") return { [keys]: data[keys] }
  if (Array.isArray(keys)) {
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = data[k]
    return out
  }
  const out: Record<string, unknown> = { ...keys }
  for (const k of Object.keys(keys)) out[k] = data[k]
  return out
}

export function installFakeChrome(initial: Record<string, unknown> = {}): FakeChromeHandle {
  const data: Record<string, unknown> = { ...initial }

  const local = {
    async get(
      keys: null | string | string[] | Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      return normalizeKeys(data, keys)
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(data, items)
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]
    }
  }

  const listeners: FakeMessageListener[] = []
  const connectListeners: Array<(port: unknown) => void> = []
  const fake = {
    storage: { local },
    runtime: {
      onMessage: {
        addListener: (fn: FakeMessageListener): void => {
          listeners.push(fn)
        }
      },
      onConnect: {
        addListener: (fn: (port: unknown) => void): void => {
          connectListeners.push(fn)
        }
      }
    }
  }
  Object.defineProperty(globalThis, "chrome", {
    value: fake,
    configurable: true,
    writable: true
  })

  return {
    data,
    listeners,
    connectListeners,
    uninstall: () => {
      Reflect.deleteProperty(globalThis, "chrome")
    }
  }
}
