// 测试共用的假 ctx。
//
// 为什么要有这个：插件的真实依赖用 ctx.inject(['tools'], cb) 等就绪，
// 测试里如果每个文件各写一份假 ctx，一旦 inject 的语义变了就要改好几处。
// 这里集中一份，语义对齐 DSH 的真实行为：服务在调用 inject 时就绪并回调。

export function makeFakeCtx(options = {}) {
  const routes = {}
  const tools = []
  const listeners = {}
  const promptDefs = []
  const injected = []

  const buildSub = (extra) => {
    const sub = {
      webServer: {
        register(route) {
          routes[route.path] = route.handler
          return () => {
            delete routes[route.path]
          }
        },
      },
      tools: {
        register(def) {
          tools.push(def)
          return () => {}
        },
      },
      systemPrompt: {
        context(def) {
          promptDefs.push(def)
          return () => {}
        },
      },
      get(name) {
        return sub[name]
      },
      effect(fn) {
        const d = fn()
        return d
      },
      ...extra,
    }
    return sub
  }

  const root = {
    routes,
    tools,
    listeners,
    promptDefs,
    injected,
    // index.js 把 systemPrompt 声明成硬依赖，所以真实 ctx 上一定有它。
    systemPrompt: {
      context(def) {
        promptDefs.push(def)
        return () => {}
      },
    },
    on(name, fn) {
      listeners[name] = fn
      return () => {
        delete listeners[name]
      }
    },
    effect(fn) {
      // effect 的回调可能返回清理函数，原样返回
      const d = fn()
      return d
    },
    inject(deps, cb) {
      injected.push(deps)
      cb(buildSub())
    },
    get() {
      return undefined
    },
  }

  if (options.systemPromptOnRoot) {
    root.systemPrompt = {
      context(def) {
        promptDefs.push(def)
        return () => {}
      },
    }
  }

  return root
}
