// 写入模式：让模型自己审视，而不是用规则猜。
//
// 设计（实测支撑）：
//   ① 规则猜「该写进哪本书」准确率只有 30%（留出验证），
//      为了补到可用堆了 400 行启发式规则 —— 那是在手工复刻模型本来就会做的事。
//   ② 模型已经读过整个对话，回头看不需要重新喂上下文，成本极低。
//   ③ 触发时机：每 N 轮（默认 3）自动审视一次；用户说「记一下」时立刻审视。
//      模型无法判断「会话结束了没」—— 用户做完事就走了，所以不能靠 turn/end 兜底。
//   ④ 模型只提交候选，用户点「记住」才落盘。未确认的东西不是记忆。

import fs from 'node:fs'
import path from 'node:path'
import { LIB_LABELS, labelOf } from './labels.js'
import { buildPreset, PRESET_NAMES } from './presets.js'

const KIND_LABEL = {
  fact: '事实',
  pref: '偏好',
  decision: '决定',
  pitfall: '踩坑',
  task: '待办',
}

// ── 调试日志 ─────────────────────────────────────────────

function stateDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  const dir = path.join(home, '.dsh', 'almost-for-ever')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function debugLog(entry, enabled) {
  if (!enabled) return
  try {
    const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`
    fs.appendFileSync(path.join(stateDir(), 'debug.log'), line, 'utf8')
  } catch {
    /* noop */
  }
}

// ── 队列存储 ─────────────────────────────────────────────

function queueFile() {
  return path.join(stateDir(), 'queue.json')
}

function loadQueue() {
  try {
    const f = queueFile()
    if (!fs.existsSync(f)) return []
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function saveQueue(items) {
  try {
    fs.writeFileSync(queueFile(), JSON.stringify(items, null, 2), 'utf8')
  } catch {
    /* 写盘失败不影响对话 */
  }
}

let seq = 0
function nextId() {
  seq += 1
  return `c${Date.now().toString(36)}${seq}`
}

// ── 运行情况统计 ─────────────────────────────────────────
//
// 「记忆」标签页要看的东西：这个会话跑了几轮、审视了几次、提醒真的注入了几次、
// 读侧命中过几个库。**只活在内存里** —— 它描述的是「这次运行」，进程重启就归零，
// 这正是我们想要的语义（重启后计数器本来就清零，见 shouldFire 的注释）。
//
// 为什么放在模块作用域而不是 applyWriteMode 里面：
//   读侧（index.js 的 systemPrompt.context）也要往同一张表里记命中，
//   两边必须共享同一个 Map，所以导出 noteReadHits() 给它用。

const RUN_STARTED = Date.now()
const STATS = new Map()
const RECENT = []
const RECENT_MAX = 60

// 全局累计（跨会话）：候选提交/接受/拒绝的总数。
// 接受和拒绝走 HTTP，请求里不带会话，所以队列项在提交那一刻就把
// sessionId 记下来，确认时按它归属。
const GLOBAL = { offered: 0, added: 0, accepted: 0, rejected: 0 }

// 最近一个开过轮的会话 —— memory_propose 的 execute 拿不到会话对象，
// 用这个归属（误差最多一轮，够用了；拿到就记，拿不到就不记）。
let LAST_SESSION_ID = ''

/** 会话 id（拿不到就空串，统计跟着失效但绝不影响主流程）。 */
export function sessionIdOf(session) {
  try {
    if (!session || typeof session !== 'object') return ''
    const id = session.id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

function statOf(session) {
  const id = sessionIdOf(session)
  if (!id) return null
  let s = STATS.get(id)
  if (!s) {
    s = {
      id,
      turns: 0,
      counter: 0,
      scheduled: 0,
      injected: 0,
      cues: 0,
      offered: 0,
      added: 0,
      accepted: 0,
      rejected: 0,
      hits: 0,
      hitTokens: 0,
      hitLibs: {},
      startedAt: Date.now(),
      lastAt: Date.now(),
      lastNudgeAt: 0,
    }
    STATS.set(id, s)
  }
  s.lastAt = Date.now()
  return s
}

/** 记一笔「最近活动」，给标签页的时间线用。 */
function noteRecent(ev, text) {
  try {
    RECENT.push({ at: Date.now(), ev, text: String(text || '').slice(0, 120) })
    if (RECENT.length > RECENT_MAX) RECENT.splice(0, RECENT.length - RECENT_MAX)
  } catch {
    /* noop */
  }
}

/**
 * 读侧命中记账（由 index.js 调用）。
 * @param {object} session - 命中发生时的 Session 对象
 * @param {Array<{stem: string, label?: string}>} hits
 * @param {number} tokens - 这次注入的估算 token
 */
export function noteReadHits(session, hits, tokens = 0) {
  try {
    const s = statOf(session)
    if (!s) return
    if (!Array.isArray(hits) || !hits.length) return
    s.hits += 1
    s.hitTokens += Number(tokens) || 0
    for (const h of hits) {
      const stem = h && h.stem
      if (typeof stem === 'string' && stem) s.hitLibs[stem] = (s.hitLibs[stem] || 0) + 1
    }
    noteRecent('hit', hits.map((h) => (h && h.stem) || '').filter(Boolean).join(' · '))
  } catch {
    /* noop */
  }
}

// ── 用户可改的设置 ───────────────────────────────────────
//
// 存在 ~/.dsh/almost-for-ever/settings.json（与 queue.json 同一个目录）。
// 只存**用户真的改过**的字段，没存的一律回落到插件 config —— 这样改
// cordis.patch.yml 仍然有效，不会被一个空的设置文件盖住。

function settingsFile() {
  return path.join(stateDir(), 'settings.json')
}

function loadSettings() {
  try {
    const f = settingsFile()
    if (!fs.existsSync(f)) return {}
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function saveSettings(next) {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return null
  return Math.min(hi, Math.max(lo, n))
}

// ── 提示词 ───────────────────────────────────────────────

/** 库名容错：模型可能写 09 / 09-windows-cmd / 09-windows-cmd.md。 */
function normalizeLib(input, libs) {
  const s = String(input || '').trim().replace(/\.md$/, '')
  if (!s) return ''
  const exact = libs.find((l) => l.stem === s)
  if (exact) return exact.stem
  const byPrefix = libs.find((l) => l.stem.startsWith(s))
  if (byPrefix) return byPrefix.stem
  const byContains = libs.find((l) => l.stem.includes(s))
  if (byContains) return byContains.stem
  return ''
}

function buildNudge(libs) {
  const usable = libs.filter((l) => l.sections.some((s) => !s.meta))
  const libList = usable.length
    ? usable.map((l) => `- ${l.stem}：${labelOf(l.stem)}`).join('\n')
    : '（当前还没有任何记忆库 —— 你可以先建议用户建一个，或者跳过这次审视）'

  return [
    '【记忆审视】到时间回头看一眼了。',
    '回顾这段对话，有没有**下次还会用到**的东西？比如：',
    '· 用户定下的规矩 / 纠正了我的做法（偏好）',
    '· 踩过的坑：症状 → 根因 → 怎么修（踩坑）',
    '· 做过且以后要遵守的决定（决定）',
    '· 环境/配置的确定事实（事实）',
    '',
    '有的话调用 `memory_propose` 工具提交，**每条一句话、独立可读**，',
    '不要写「这个」「刚才那个」这种依赖上下文的指代。用户会在弹窗里确认。',
    '没有值得记的就**不用调用**，不要为了交差硬凑。',
    '',
    '⚠️ 写之前先用 `read` 看一眼目标库的那一节，**照它已有的格式写**：',
    '那节是表格就写成表格行，是 `- ` 列表就写成列表项，是编号就接着编号。',
    '**格式在写的时候一次到位，不要指望"先记下来以后再整理"** ——',
    '攒一堆格式不齐的条目，整理成本远高于当时多花十秒。',
    '落盘时插件会按目标节的既有格式再校验一遍，格式不对会被拒绝。',
    '',
    '**改旧条目 / 删旧条目也用这个工具**：给 `op: "replace"`（或 `"delete"`），',
    '再给一段能唯一定位那一行的 `match` 原文；`text` 写改写后的新内容（delete 不用给）。',
    '**事实变了就改写那一条，别追加新的把旧的留着** —— 两条互相打架比没有更糟。',
    '',
    '可以写进这些库（第一个词就是库名）：',
    libList,
  ].join('\n')
}

// 用户在弹窗里点「说两句」之后，把他的话带给模型。
// **不做任何模型调用** —— 攒到下一轮随上下文一起交给模型，
// 好处是零额外开销、而且模型看得见完整对话（孤立地看一条候选判断不准）。
function buildReviseText() {
  let items = []
  try {
    items = loadQueue().filter((c) => c && c.note)
  } catch {
    return ''
  }
  if (items.length === 0) return ''

  const lines = [
    '【记忆候选·你的要求】下面这些候选还没确认，用户对它们说了话。',
    '请按他的意思处理，**不要原样再提一遍**：',
  ]
  for (const c of items.slice(0, 6)) {
    const where = c.stem ? labelOf(c.stem) : '未指定库'
    const body = c.op === 'replace' || c.op === 'delete'
      ? `${c.op === 'replace' ? '改写' : '删除'}「${String(c.target && c.target.original || '').slice(0, 160)}」` +
        (c.op === 'replace' ? ` → 「${String(c.text || '').slice(0, 160)}」` : '')
      : String(c.text || '').slice(0, 200)
    lines.push('')
    lines.push(`候选 #${c.id}（原定：${where}）`)
    lines.push(`  内容：${body}`)
    lines.push(`  用户说：「${String(c.note).slice(0, 300)}」`)
  }
  lines.push('')
  lines.push('怎么处理由你判断：改写措辞、合并进已有条目、拆成两条、换一个库，或者认为不该记。')
  lines.push('处理完调用 `memory_propose`，把 `reviseOf` 填成上面那个候选 id：')
  lines.push('· 要收录 → 照常给 text / lib / kind（可以改），并带 `reviseOf`')
  lines.push('· 不该收录 → `op: "drop"` + `reviseOf`，不用给 text')
  lines.push('提交后原候选会自动撤掉，弹窗里不会重复出现。')
  return lines.join('\n')
}

/** 用户说了记录口令 —— 立刻审视一次。 */
const REMEMBER_CUE = /记一下|记住|记下来|记着|写进记忆|记录一下|存进记忆|做好索引/

/**
 * 这条 user/message 是不是用户本人说的。
 *
 * `user/message` 这个事件类型装的不只人的话：宿主的运行时上下文快照
 * （`Current runtime context…`，见 packages/core/system-prompt/src/index.ts
 * 的 joinContextSections）也以 user/message 落盘，只是 source 是
 * `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`。
 * 只有 `source.kind === 'user'` 才是人打的字。
 */
function isUserSpoken(data) {
  if (!data || typeof data !== 'object') return false
  const src = data.source
  if (!src || typeof src !== 'object') return false
  return src.kind === 'user'
}

// ⚠️ 两套「会话」不是同一个对象：
//   · `session/event` 回调收到的是 **Session**
//   · `systemPrompt.context` 里 `assembleContext.scope` 是 **Agent**（agent.session === session）
// 两边必须换算到同一把钥匙，否则 WeakMap 存进去永远取不到。
// 见 packages/core/agent/src/dispatch.ts 的 assembleContextFor()。
function scopeSession(scope) {
  if (!scope || typeof scope !== 'object') return undefined
  const session = scope.session
  if (session && typeof session === 'object') return session
  return scope
}

// ── 注册入口 ─────────────────────────────────────────────

export function applyWriteMode(ctx, config = {}) {
  const deriveIndex = config.deriveIndex
  const memoryDir =
    config.memoryDir ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'memory')

  // 设置优先级：settings.json（用户在标签页里改的） > 插件 config > 内置默认。
  // 之所以不是反过来：标签页里点一下就要立刻生效，而 config 要改文件 + 重启。
  const stored = loadSettings()

  let writeEnabled =
    typeof stored.writeEnabled === 'boolean'
      ? stored.writeEnabled
      : config.writeEnabled !== false
  let debug = typeof stored.debug === 'boolean' ? stored.debug : config.debug === true
  // 浮层（📌 / 🗂 两个小圆片）要不要显示 —— 只影响界面，服务端照样工作。
  let chips = typeof stored.chips === 'boolean' ? stored.chips : true

  // 触发间隔：可以按「轮数」也可以按「token 数」。
  //   intervalUnit  = 'turns'（默认）| 'tokens'
  //   intervalValue = 该单位下的阈值
  // 向后兼容：老的 everyTurns 仍然生效。
  const intervalUnit = config.intervalUnit === 'tokens' ? 'tokens' : 'turns'
  const configInterval = Number.isFinite(config.intervalValue)
    ? config.intervalValue
    : intervalUnit === 'tokens'
      ? 20000
      : Number.isFinite(config.everyTurns)
        ? config.everyTurns
        : 3
  const storedInterval = clampInt(stored.intervalValue, 1, 100)
  let intervalValue = storedInterval === null ? configInterval : storedInterval

  // 每个会话的计数（轮数或累计 token）
  const counters = new WeakMap()
  const pendingNudge = new WeakMap()

  const shouldFire = (session) => {
    const n = counters.get(session) || 0
    if (n === 0) return false
    // 到达阈值即触发，并把计数归零 —— 否则后面每步都会触发
    if (n >= intervalValue) {
      counters.set(session, 0)
      return true
    }
    return false
  }

  /**
   * 排一次提醒。
   *
   * ⚠️ 文本在**触发这一刻**就算好，不让注入回调现算 —— 因为那个回调同一个
   * step 里会被调用不止一次（见下方 `prompt.context` 处的注释）。算好放这儿，
   * 回调每次返回同一份文本，宿主那边 `deepEqualJson` 判定「没变」就不会重复落盘。
   */
  const scheduleNudge = (session, why) => {
    let text = ''
    try {
      text = buildNudge(libs())
    } catch {
      text = ''
    }
    pendingNudge.set(session, { why, text, logged: false })
  }

  const libs = () => {
    try {
      return deriveIndex ? deriveIndex(memoryDir) : []
    } catch {
      return []
    }
  }

  // ── 计数 + 口令触发 ──────────────────────────────────
  // 轮数：turn/start 计数；token：读 assistant/message 的 usage 累加。
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      try {
        if (!event) return

        if (intervalUnit === 'turns') {
          if (event.type === 'turn/start') {
            // 新的一轮开始：上一轮的提醒作废。提醒的生命周期 = 一轮，
            // 这样它既不会一直挂在那里，也不会因为「只取一次」而丢掉。
            pendingNudge.delete(session)
            const n = (counters.get(session) || 0) + 1
            counters.set(session, n)
            const st = statOf(session)
            if (st) {
              st.turns += 1
              st.counter = n
              LAST_SESSION_ID = st.id
            }
            if (shouldFire(session)) {
              scheduleNudge(session, 'auto')
              if (st) {
                st.counter = 0
                st.scheduled += 1
                st.lastNudgeAt = Date.now()
              }
              noteRecent('nudge', '自动审视（每 ' + intervalValue + ' 轮）')
              debugLog({ ev: 'nudge-scheduled', unit: 'turns', at: intervalValue }, debug)
            }
          }
        } else {
          // token 口径：累加本次请求真实消耗的输入 token
          if (event.type === 'assistant/message' || event.type === 'request/header') {
            const usage = event.data && event.data.usage
            const add =
              (usage && (usage.inputTokens || 0)) ||
              (event.type === 'assistant/message' ? 0 : 0)
            if (add > 0) {
              counters.set(session, (counters.get(session) || 0) + add)
              if (shouldFire(session)) {
                scheduleNudge(session, 'auto')
                const st = statOf(session)
                if (st) {
                  st.scheduled += 1
                  st.lastNudgeAt = Date.now()
                }
                noteRecent('nudge', '自动审视（每 ' + intervalValue + ' token）')
                debugLog({ ev: 'nudge-scheduled', unit: 'tokens',
                  at: intervalValue, total: add }, debug)
              }
            }
          }
        }

        // ⚠️ user/message 不只装人的话：宿主的运行时上下文快照
        // （「Current runtime context…」）也以 user/message 落盘，source 是
        // { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }。
        // 只认 kind === 'user' 才是用户真说的 —— 否则口令会被注入文本反复误触发，
        // 会变成几乎每轮都提醒一次。
        if (event.type === 'user/message' && isUserSpoken(event.data)) {
          const text = contentToText(event.data && event.data.content)
          if (text && REMEMBER_CUE.test(text)) {
            scheduleNudge(session, 'cue')
            const st = statOf(session)
            if (st) st.cues += 1
            noteRecent('cue', text.slice(0, 40))
            debugLog({ ev: 'nudge-cue', text: text.slice(0, 40) }, debug)
          }
        }
      } catch (e) {
        debugLog({ ev: 'count-error', msg: String(e && e.message) }, debug)
      }
    }),
  )

  // ── 注入提示（每轮组装时检查） ─────────────────────────
  const sp = ctx.get ? ctx.get('systemPrompt') : undefined
  const prompt = sp || ctx.systemPrompt
  if (prompt && typeof prompt.context === 'function') {
    ctx.effect(() =>
      prompt.context({
        name: 'almost-for-ever-nudge',
        order: 56,
        // ⚠️ 这个回调**同一个 step 里会被调用两次**，不是一次：
        //   ① `preStep()` 里 `systemPrompt.assemble()` —— 结果只用来算快照；
        //   ② `step()` 里 `systemPrompt.refreshContext(assembly, …)` —— **真正落盘的那份**。
        //      见 @deepseek-ai/dsh-agent-loop 的 agent.ts:452-456
        //      （refreshContext → renderContextSections → runtimeContext.project）。
        // `refreshContext`（@deepseek-ai/dsh-system-prompt 的 index.ts:589-608，第 599 行）
        // 会把所有 context provider 重跑一遍。
        // 所以这里**绝不能「读一次就删」**：第一次把提醒消费掉，第二次就返回空串，
        // 会被 `renderContextSections` 的 `.filter(text.length > 0)` 过滤掉，
        // 落盘的快照里就没有提醒 —— 模型根本收不到，自然也不会调 memory_propose。
        // 必须幂等：只读不删，作废时机交给 `turn/start`。
        text: (assembleContext) => {
          try {
            if (!writeEnabled) return ''
            const key = scopeSession(assembleContext && assembleContext.scope)
            if (!key) return ''
            const item = pendingNudge.get(key)
            if (!item || !item.text) return ''
            if (item.logged !== true) {
              item.logged = true
              const st = statOf(key)
              if (st) st.injected += 1
              noteRecent('injected', '提醒已进上下文（' + item.why + '）')
              debugLog({ ev: 'nudge-injected', why: item.why, len: item.text.length }, debug)
            }
            return item.text
          } catch {
            return ''
          }
        },
      }),
    )

    // 用户在弹窗里点了「说两句」—— 把他的话带进上下文，由模型决定怎么处理。
    // 同样**只读不删**（同一个 step 会被 assemble + refreshContext 调两次）：
    // 这段文字要一直挂到模型真的用 reviseOf / drop 处理掉那条候选为止，
    // 那时候队列里没有 note 了，自然就消失了。
    ctx.effect(() =>
      prompt.context({
        name: 'almost-for-ever-revise',
        order: 57,
        text: () => {
          try {
            if (!writeEnabled) return ''
            return buildReviseText()
          } catch {
            return ''
          }
        },
      }),
    )
  }
  // ── memory_propose 工具 ────────────────────────────────
  // 同样用 ctx.inject 等 tools 就绪（原因见下方 HTTP 段注释）。
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.tools || (toolCtx.get && toolCtx.get('tools'))
    if (!tools || typeof tools.register !== 'function') return
    toolCtx.effect(() =>
      tools.register({
        name: 'memory_propose',
        description:
          '把值得长期记住的内容提交给用户确认。用户点「记住」后才会真正写入记忆库；' +
          '点「不要」或「全部忽略」则丢弃。只在确实有下次还用得上的东西时才调用。' +
          '三种操作：追加（默认）、改写已有的一行（op: "replace" + match）、' +
          '删除已有的一行（op: "delete" + match）。事实变了就改写那一条，不要追加新的。' +
          '目标节是表格时，text 要写成一行表格（以 | 开头、列数与表头一致），否则会被拒绝。' +
          '用户在弹窗里点「说两句」对某条候选提了要求时，上下文里会告诉你；' +
          '按他的意思重新判断，用 reviseOf 指向那条候选：要收录就照常给 text/lib/kind，' +
          '认为不该记就给 op: "drop"。提交后原候选会自动撤掉。',
        parameters: {
          type: 'object',
          properties: {
            candidates: {
              type: 'array',
              description: '值得记的条目，通常 1~5 条',
              items: {
                type: 'object',
                properties: {
                  text: {
                    type: 'string',
                    description:
                      '一句话、独立可读，不依赖上下文指代。' +
                      '写进表格节时要写成一行表格：| 甲 | 乙 |，列数与表头一致。',
                  },
                  kind: {
                    type: 'string',
                    enum: ['fact', 'pref', 'decision', 'pitfall', 'task'],
                    description: '事实 / 偏好 / 决定 / 踩坑 / 待办',
                  },
                  lib: {
                    type: 'string',
                    description: '要写进的记忆库名，如 09-windows-cmd',
                  },
                  why: {
                    type: 'string',
                    description: '为什么值得记，一句话',
                  },
                  op: {
                    type: 'string',
                    enum: ['append', 'replace', 'delete', 'drop'],
                    description:
                      '默认 append（追加一条）。replace = 改写已有的一行，delete = 删掉已有的一行；' +
                      '这两种都必须同时给 match。drop = 这条不该记，把 reviseOf 指的那条候选撤掉。',
                  },
                  match: {
                    type: 'string',
                    description:
                      'op 是 replace / delete 时必填：目标那一行里一段足够独特的原文片段，用来定位它。' +
                      '命中多行会被拒绝，要给更长的一段。',
                  },
                  reviseOf: {
                    type: 'string',
                    description:
                      '正在处理的那条待确认候选 id（上下文里以 # 开头那串）。填了它，这条候选进队列后' +
                      '原候选会自动撤掉，弹窗里不会重复出现。',
                  },
                },
                required: [],
              },
            },
          },
          required: ['candidates'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              accepted: { type: 'number' },
              dropped: { type: 'number' },
              skipped: { type: 'array', items: { type: 'string' } },
            },
          },
          render(args, value) {
            const n = (value && value.count) || 0
            const dp = (value && value.dropped) || 0
            const sk = (value && value.skipped) || []
            const head = n
              ? `已提交 ${n} 条候选，等用户在弹窗里确认后才会写入记忆库。`
              : '没有提交任何候选。'
            const tail = dp ? ` 另有 ${dp} 条按用户要求撤掉了。` : ''
            return [
              {
                type: 'text',
                text: sk.length ? `${head} 跳过：${sk.join('；')}${tail}` : head + tail,
              },
            ]
          },
        },
        async execute(args) {
          const list = Array.isArray(args && args.candidates) ? args.candidates : []
          const known = libs()
          const queue = loadQueue()
          let added = 0
          let dropped = 0
          const skipped = []

          for (const c of list) {
            const op =
              c && (c.op === 'replace' || c.op === 'delete' || c.op === 'drop') ? c.op : 'append'
            const text = String((c && c.text) || '').replace(/\s+/g, ' ').trim()
            const match = String((c && c.match) || '').trim()
            const reviseOf = String((c && c.reviseOf) || '').trim()

            // 用户点了「说两句」，模型判断这条根本不该记 —— 直接把原候选撤掉，不写库
            if (op === 'drop') {
              if (!reviseOf) {
                skipped.push('drop 必须给 reviseOf（要撤掉哪条候选）')
                continue
              }
              const at = queue.findIndex((q) => q.id === reviseOf)
              if (at < 0) {
                skipped.push('reviseOf 指向的候选已经不在队列里了')
                continue
              }
              queue.splice(at, 1)
              dropped += 1
              GLOBAL.rejected += 1
              continue
            }

            if (op !== 'delete' && (!text || text.length > 400)) {
              skipped.push('内容为空或超过 400 字')
              continue
            }
            // 带 reviseOf 时允许与原文相同（用户只是让它换个库或换个说法）
            if (op === 'append' && !reviseOf && queue.some((q) => q.text === text)) continue

            const kind = KIND_LABEL[c && c.kind] ? c.kind : 'fact'
            const stem = normalizeLib(c && c.lib, known)
            const why = String((c && c.why) || '').slice(0, 120)

            // 这条是在处理哪条待确认候选 —— 它进队列后，原候选就该撤掉
            const retire = () => {
              if (!reviseOf) return
              const at = queue.findIndex((q) => q.id === reviseOf)
              if (at >= 0) queue.splice(at, 1)
            }

            if (op === 'append') {
              const sec = stem
                ? bestSection(known.find((l) => l.stem === stem), text)
                : ''
              queue.push({
                id: nextId(),
                op: 'append',
                text,
                kind,
                score: 0,
                why,
                stem,
                section: sec,
                where: stem ? labelOf(stem) : '',
                sessionId: LAST_SESSION_ID,
                revisedFrom: reviseOf || '',
                createdAt: Date.now(),
              })
              retire()
              added += 1
              continue
            }

            // replace / delete：必须当场定位到**唯一一行**才进队列。
            // 宁可拒掉让模型给更长的片段，也不在落盘时猜是哪一行。
            if (!stem) {
              skipped.push('改写/删除必须指定库（lib）')
              continue
            }
            if (!match) {
              skipped.push('改写/删除必须给 match（目标行的原文片段）')
              continue
            }
            const hit = resolveTarget(memoryDir, stem, match)
            if (!hit.ok) {
              skipped.push(hit.reason)
              continue
            }
            queue.push({
              id: nextId(),
              op,
              text,
              kind,
              score: 0,
              why,
              stem,
              section: '',
              where: labelOf(stem),
              target: { line: hit.line, original: hit.original },
              sessionId: LAST_SESSION_ID,
              revisedFrom: reviseOf || '',
              createdAt: Date.now(),
            })
            retire()
            added += 1
          }

          saveQueue(queue.slice(-40))
          GLOBAL.offered += list.length
          GLOBAL.added += added
          const st = LAST_SESSION_ID ? STATS.get(LAST_SESSION_ID) : null
          if (st) {
            st.offered += list.length
            st.added += added
          }
          noteRecent('propose', `提交 ${added} 条候选` + (skipped.length ? `，跳过 ${skipped.length} 条` : ''))
          debugLog({ ev: 'propose', offered: list.length, added, dropped, skipped }, debug)
          return { count: added, accepted: list.length, dropped, skipped }
        },
      }),
    )
  })
  // ── HTTP：便利贴 + 结构面板用的接口 ───────────────────
  // ⚠️ 必须用 ctx.inject 等 webServer 就绪。
  // 实测教训：用 ctx.get('webServer') 在 apply 时取，服务还没起来就拿到 undefined，
  // 于是这一整段 return 掉、所有接口一个都没注册 —— 表现为「/pending 404」，
  // 且没有任何报错。DSH 自带的 dsh-better-sidebar / dsh-restart-now 都这么写。
  ctx.inject(['webServer'], (hostCtx) => {
    const ws = hostCtx.webServer || (hostCtx.get && hostCtx.get('webServer'))
    if (!ws || typeof ws.register !== 'function') {
      debugLog({ ev: 'webserver-missing' }, debug)
      return
    }
    debugLog({ ev: 'webserver-ready' }, debug)

    hostCtx.effect(() => {
      const offs = [
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/pending',
          handler: (req, res) => {
            const items = loadQueue().map((c) => ({
              id: c.id,
              op: c.op || 'append',
              text: c.text,
              line: c.target ? c.target.line : 0,
              original: c.target ? c.target.original : '',
              kind: c.kind,
              kindLabel: KIND_LABEL[c.kind] || '其它',
              guessed: c.stem || '',
              guessedLabel: c.stem ? labelOf(c.stem) : '',
              where: c.where || '',
              why: c.why || '',
              note: c.note || '',
              notedAt: c.notedAt || 0,
            }))
            writeJson(res, {
              items,
              targets: buildTargets(libs()),
              interval: { unit: intervalUnit, value: intervalValue },
            })
          },
        }),
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/accept',
          handler: (req, res) => handleAccept(req, res, memoryDir, debug),
        }),
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/reject',
          handler: (req, res) => {
            readBody(req).then((body) => {
              const id = body && body.id
              const queue = loadQueue()
              const item = queue.find((c) => c.id === id)
              saveQueue(queue.filter((c) => c.id !== id))
              GLOBAL.rejected += 1
              const st = item && item.sessionId ? STATS.get(item.sessionId) : null
              if (st) {
                st.rejected += 1
              }
              noteRecent('reject', (item && item.stem) || '丢弃一条候选')
              writeJson(res, { ok: true })
            })
          },
        }),
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/dismiss',
          handler: (req, res) => {
            saveQueue([])
            writeJson(res, { ok: true })
          },
        }),
        // 「说两句」：把用户的要求挂到那条候选上。note 为空 = 撤销。
        // 这里**不调模型** —— 要求会在下一轮随上下文交给模型（见 almost-for-ever-revise）。
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/revise',
          handler: (req, res) => {
            readBody(req)
              .then((body) => {
                const id = body && body.id
                const note = String((body && body.note) || '').trim().slice(0, 500)
                const queue = loadQueue()
                const item = queue.find((c) => c.id === id)
                if (!item) {
                  writeJson(res, { ok: false, error: '这条候选已经不在了' })
                  return
                }
                if (note) {
                  item.note = note
                  item.notedAt = Date.now()
                } else {
                  delete item.note
                  delete item.notedAt
                }
                saveQueue(queue)
                noteRecent('revise', note ? note.slice(0, 40) : '撤回了要求')
                debugLog({ ev: 'revise', id, note: note.slice(0, 60) }, debug)
                writeJson(res, { ok: true, note })
              })
              .catch((e) => writeJson(res, { ok: false, error: String(e && e.message) }))
          },
        }),
        // 结构面板数据：每个记忆库的章节、标签、行号区间、大小估算
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/tree',
          handler: (req, res) => {
            try {
              const data = buildTree(libs())
              writeJson(res, data)
            } catch (e) {
              writeJson(res, { error: String(e && e.message), libs: [] })
            }
          },
        }),
        // 写入下拉的目标列表：**从实际扫描到的库来**，不是硬编码表。
        // 实测：写死 16 个目标时，别人的库一个都选不到，
        // 而他自己的库名又全在“不存在”的列表里。
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/targets',
          handler: (req, res) => {
            try {
              writeJson(res, { targets: buildTargets(libs()) })
            } catch (e) {
              writeJson(res, { targets: LIB_LABELS, error: String(e && e.message) })
            }
          },
        }),
        // ── 运行情况：会话标签页 / 设置页轮询这个 ─────────────
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/stats',
          handler: (req, res) => {
            try {
              const sid = queryParam(req, 'session')
              const all = libs()
              writeJson(res, buildStats({
                libs: all,
                sessionId: sid,
                intervalUnit,
                intervalValue,
                settings: { writeEnabled, debug, chips, intervalValue },
                memoryDir,
              }))
            } catch (e) {
              writeJson(res, { ok: false, error: String(e && e.message) })
            }
          },
        }),
        // ── 设置：GET 读当前，POST 改（改完立刻生效，也写进 settings.json）──
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/settings',
          handler: (req, res) => {
            const reply = () =>
              writeJson(res, {
                ok: true,
                settings: { intervalValue, writeEnabled, debug, chips },
                intervalUnit,
              })
            if (req.method !== 'POST') {
              reply()
              return
            }
            readBody(req)
              .then((body) => {
                const patch = body && typeof body === 'object' ? body : {}
                const next = { ...loadSettings() }
                if ('intervalValue' in patch) {
                  const v = clampInt(patch.intervalValue, 1, 100)
                  if (v !== null) {
                    intervalValue = v
                    next.intervalValue = v
                  }
                }
                if (typeof patch.writeEnabled === 'boolean') {
                  writeEnabled = patch.writeEnabled
                  next.writeEnabled = patch.writeEnabled
                }
                if (typeof patch.debug === 'boolean') {
                  debug = patch.debug
                  next.debug = patch.debug
                }
                if (typeof patch.chips === 'boolean') {
                  chips = patch.chips
                  next.chips = patch.chips
                }
                saveSettings(next)
                noteRecent('settings', '设置已更新')
                debugLog({ ev: 'settings', ...next }, debug)
                reply()
              })
              .catch((e) => writeJson(res, { ok: false, error: String(e && e.message) }))
          },
        }),
        // 空记忆库时的一键起手模板
        ws.register({
          kind: 'exact',
          path: '/almost-for-ever/scaffold',
          handler: (req, res) => {
            readBody(req).then((body) => {
              try {
                const preset = String((body && body.preset) || 'minimal')
                const result = scaffold(memoryDir, preset)
                writeJson(res, result)
              } catch (e) {
                writeJson(res, { ok: false, reason: String(e && e.message) })
              }
            })
          },
        }),
      ]
      return () => {
        for (const off of offs) {
          try {
            off()
          } catch {
            /* noop */
          }
        }
      }
    })
  })
}

/**
 * 一键生成起手模板。
 *
 * 安全纪律：**绝不覆盖已有文件**。同名文件存在就跳过并记进 skipped，
 * 结果原样回给用户看「哪些建了、哪些没动」。
 */
function scaffold(memoryDir, preset) {
  const files = buildPreset(preset)
  if (!files) {
    return { ok: false, reason: `未知模板：${preset}（可选 ${PRESET_NAMES.join(' / ')}）` }
  }

  try {
    fs.mkdirSync(memoryDir, { recursive: true })
  } catch (e) {
    return { ok: false, reason: `建不了记忆目录：${e && e.message}` }
  }

  const created = []
  const skipped = []
  for (const f of files) {
    const full = path.join(memoryDir, f.file)
    if (fs.existsSync(full)) {
      skipped.push(f.file)
      continue
    }
    try {
      fs.writeFileSync(full, f.content, 'utf8')
      created.push(f.file)
    } catch (e) {
      skipped.push(`${f.file}（写入失败：${e && e.message}）`)
    }
  }
  return { ok: created.length > 0, created, skipped, preset }
}

/**
 * 下拉目标的来源：**实际存在的库**，不是硬编码表。
 *
 * 为什么改：原来写死 16 个目标（全是作者这边的库）。别人的库叫「工作日志」
 * 「health」，下拉里一个都选不到；反过来下拉里又列了 16 个他根本不存在的库，
 * 点了「记住」只会写进一个不存在的文件。
 *
 * 排序：先人工标好的白话名（作者这边的库有），再按 token 多少排，
 * 元章节（子索引/其他）不列。
 */
function buildTargets(libs) {
  const list = []
  for (const lib of libs) {
    if (!lib.sections.some((s) => !s.meta)) continue
    list.push({
      stem: lib.stem,
      label: labelOf(lib.stem),
      hint: lib.title ? lib.title.slice(0, 40) : '',
      tokens: lib.sections.reduce((n, s) => n + (Number.isFinite(s.chars) ? s.chars : 0), 0),
    })
  }
  // 人工白话名排前面，其余按体积
  list.sort((a, b) => {
    const la = LIB_LABELS.some((x) => x.stem === a.stem) ? 0 : 1
    const lb = LIB_LABELS.some((x) => x.stem === b.stem) ? 0 : 1
    if (la !== lb) return la - lb
    return b.tokens - a.tokens
  })
  return list.map(({ stem, label, hint }) => ({ stem, label, hint }))
}

/**
 * 把 deriveIndex 的结果压成 UI 能画的结构。
 * 每个库：文件名、标题、标签、估算 token、章节数；
 * 每个章节：标题、行号区间、估算 token、标签、条目数、是否元章节。
 *
 * token 估算用真实字符数（sec.chars），不是「行数 × 40」 ——
 * 后者对表格/长行严重低估（实测差 3.5 倍）。
 */
function buildTree(libs) {
  let totalTokens = 0
  const out = libs.map((lib) => {
    let libTokens = 0
    const sections = lib.sections.map((sec) => {
      const chars = Number.isFinite(sec.chars)
        ? sec.chars
        : Math.max(1, sec.endLine - sec.line + 1) * 40
      const est = Math.round(chars / 1.5)
      libTokens += est
      return {
        title: sec.title,
        line: sec.line,
        endLine: sec.endLine,
        tokens: est,
        meta: Boolean(sec.meta),
        tags: [...(sec.tags || [])],
        entries: sec.entries ? sec.entries.length : 0,
      }
    })
    totalTokens += libTokens
    return {
      file: lib.file,
      stem: lib.stem,
      title: lib.title || lib.stem,
      label: labelOf(lib.stem),
      tags: [...(lib.tags || [])],
      tokens: libTokens,
      sections,
    }
  })
  return { libs: out, totalTokens, generatedAt: Date.now() }
}

// ── 运行情况：标签页 / 设置页要的数据 ─────────────────────

/** 取 URL 查询参数（拿不到就空串）。 */
function queryParam(req, name) {
  try {
    const raw = req && req.url ? String(req.url) : ''
    const q = raw.indexOf('?')
    if (q < 0) return ''
    return new URLSearchParams(raw.slice(q + 1)).get(name) || ''
  } catch {
    return ''
  }
}

/** 每个库的体积摘要（按 token 从大到小）。 */
function libSummary(libs) {
  return libs
    .map((lib) => {
      let tokens = 0
      let entries = 0
      for (const sec of lib.sections) {
        const chars = Number.isFinite(sec.chars)
          ? sec.chars
          : Math.max(1, sec.endLine - sec.line + 1) * 40
        tokens += Math.round(chars / 1.5)
        entries += sec.entries ? sec.entries.length : 0
      }
      return {
        stem: lib.stem,
        label: labelOf(lib.stem),
        tokens,
        sections: lib.sections.length,
        entries,
      }
    })
    .sort((a, b) => b.tokens - a.tokens)
}

/**
 * 拼出标签页要的整份数据。
 *
 * 分三块：
 *   · session —— 这个会话的运行情况（轮次 / 距下次审视 / 提醒 / 命中）
 *   · global  —— 这次进程启动以来的累计
 *   · libs    —— 记忆库体积一览
 * 会话不在统计表里时 `session` 返回 null，界面显示「本会话还没开始计数」。
 */
function buildStats({ libs, sessionId, intervalUnit, intervalValue, settings, memoryDir }) {
  const summary = libSummary(libs)
  const totalTokens = summary.reduce((n, l) => n + l.tokens, 0)

  let session = null
  const raw = sessionId ? STATS.get(sessionId) : null
  if (raw) {
    const counter = Number.isFinite(raw.counter) ? raw.counter : 0
    session = {
      id: raw.id,
      turns: raw.turns,
      scheduled: raw.scheduled,
      injected: raw.injected,
      cues: raw.cues,
      offered: raw.offered,
      added: raw.added,
      accepted: raw.accepted,
      rejected: raw.rejected,
      hits: raw.hits,
      hitTokens: raw.hitTokens,
      hitLibs: Object.entries(raw.hitLibs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([stem, count]) => ({ stem, label: labelOf(stem), count })),
      startedAt: raw.startedAt,
      lastAt: raw.lastAt,
      lastNudgeAt: raw.lastNudgeAt,
      untilNext: Math.max(0, intervalValue - counter),
    }
  }

  let turns = 0
  let injected = 0
  let hits = 0
  for (const s of STATS.values()) {
    turns += s.turns
    injected += s.injected
    hits += s.hits
  }

  return {
    ok: true,
    sessionId: sessionId || '',
    session,
    global: {
      sessions: STATS.size,
      turns,
      injected,
      hits,
      offered: GLOBAL.offered,
      added: GLOBAL.added,
      accepted: GLOBAL.accepted,
      rejected: GLOBAL.rejected,
      queue: loadQueue().length,
      uptimeMs: Date.now() - RUN_STARTED,
      startedAt: RUN_STARTED,
    },
    libs: summary,
    totalTokens,
    memoryDir,
    interval: { unit: intervalUnit, value: intervalValue },
    settings,
    recent: RECENT.slice(-24).reverse(),
  }
}

// ── 确认写入 ─────────────────────────────────────────────

async function handleAccept(req, res, memoryDir, debug) {
  try {
    const body = await readBody(req)
    const id = body && body.id
    const chosen = body && typeof body.stem === 'string' ? body.stem : ''

    const queue = loadQueue()
    const item = queue.find((c) => c.id === id)
    if (!item) {
      writeJson(res, { ok: false, error: 'not-found' })
      return
    }
    if (chosen) item.stem = chosen

    const result =
      item.op === 'replace'
        ? replaceInMemory(memoryDir, item)
        : item.op === 'delete'
          ? deleteInMemory(memoryDir, item)
          : appendToMemory(memoryDir, item)
    if (result.ok) saveQueue(queue.filter((c) => c.id !== id))
    if (result.ok) {
      GLOBAL.accepted += 1
      const st = item.sessionId ? STATS.get(item.sessionId) : null
      if (st) st.accepted += 1
      noteRecent('accept', `${item.op === 'delete' ? '删掉' : item.op === 'replace' ? '改写' : '记住'} ${item.stem || ''}`)
    }
    debugLog(
      { ev: 'accept', ok: result.ok, op: item.op || 'append', stem: item.stem,
        format: result.format, reason: result.reason,
        text: String(item.text || '').slice(0, 40) },
      debug,
    )
    // 失败时把原因回给弹窗，让用户看到「为什么没写进去」
    writeJson(res, { ok: result.ok, where: item.stem, reason: result.reason })
  } catch (e) {
    writeJson(res, { ok: false, error: String(e && e.message) })
  }
}

/**
 * 探测某一节的「主流格式」。返回 'bullet' | 'numbered' | 'table'。
 *
 * 为什么要这个：模型可能忘、可能偷懒，但落盘这一道是插件控制的。
 * 格式在写的时候一次到位 —— 攒一堆格式不齐的条目，整理成本远高于当时多花十秒。
 *
 * 导出是为了让测试直接 import 真实实现，不再复制一份逻辑（复制会分叉）。
 */
export function detectSectionFormat(lines, start, end) {
  let bullet = 0
  let numbered = 0
  let table = 0
  let other = 0

  for (let i = start + 1; i < end; i += 1) {
    const s = lines[i].trim()
    if (!s || s.startsWith('<!--') || s.startsWith('#')) continue
    if (/^[-*]\s/.test(s)) bullet += 1
    else if (/^\d+[.、)]\s/.test(s)) numbered += 1
    else if (s.startsWith('|')) table += 1
    else other += 1
  }

  const total = bullet + numbered + table + other
  if (total === 0) return 'bullet' // 空节默认 bullet
  // 表格必须占绝对多数才算表格 —— 表格行混进一条 bullet 很难看
  if (table / total >= 0.6) return 'table'
  if (numbered / total >= 0.5) return 'numbered'
  if (bullet / total >= 0.5) return 'bullet'
  return 'bullet'
}

/**
 * 追加一条到目标库的目标章节末尾。只 append，不改别的。
 *
 * 格式处理：
 *   bullet    → 前加 `- `
 *   numbered  → 接着编号
 *   table     → 只有「内容本身已是一行表格且列数与表头一致」才放行（见 appendTableRow）
 * 没指定库就落到 02-preferences。
 *
 * 返回 { ok, reason }。
 */
export function appendToMemory(memoryDir, item) {
  const stem = item.stem || '02-preferences'
  const section = item.section || ''

  const file = stem.endsWith('.md') ? stem : `${stem}.md`
  const full = path.join(memoryDir, file)
  if (!fs.existsSync(full)) {
    return { ok: false, reason: `目标文件不存在：${file}` }
  }

  const lines = fs.readFileSync(full, 'utf8').split('\n')

  // 先把目标节的区间定出来
  let start = -1
  let end = lines.length
  if (section) {
    start = lines.findIndex((l) => l.startsWith('## ') && l.includes(section))
    if (start >= 0) {
      for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i].startsWith('## ')) {
          end = i
          break
        }
      }
    }
  }

  const fmt = start >= 0 ? detectSectionFormat(lines, start, end) : 'bullet'

  // 表格节：列数不猜 —— 但内容本身已经是表格行、列数也对得上时放行。
  // 早先这里是一律拒绝，可提示语又让模型「照那节的格式写」，
  // 结果模型老老实实写成表格行也被打回，自相矛盾（2026-11-17 踩到）。
  if (fmt === 'table') {
    return appendTableRow(full, lines, start, end, section, item)
  }

  // 定位插入点
  let insertAt = end
  while (insertAt > (start >= 0 ? start + 1 : 0) && lines[insertAt - 1].trim() === '') {
    insertAt -= 1
  }

  const oneLine = String(item.text).replace(/\s+/g, ' ').trim()
  if (!oneLine) return { ok: false, reason: '内容为空' }

  // 行尾跟文件走：记忆库是 CRLF，插一行 LF 进去就成了混行尾，
  // git diff 会整段变红，看着像改了一大片。
  const eol = insertAt > 0 && lines[insertAt - 1].endsWith('\r') ? '\r' : ''

  let line
  if (fmt === 'numbered') {
    // 接着这一节已有的最大编号往下数
    let maxNo = 0
    for (let i = (start >= 0 ? start + 1 : 0); i < end; i += 1) {
      const m = /^(\d+)[.、)]\s/.exec(lines[i].trim())
      if (m) maxNo = Math.max(maxNo, Number(m[1]))
    }
    line = `${maxNo + 1}. ${oneLine}`
  } else {
    // bullet 与 plain 都按 `- ` 处理；若已有 `- ` 前缀则不重复加
    line = /^[-*]\s/.test(oneLine) ? oneLine : `- ${oneLine}`
  }

  lines.splice(insertAt, 0, line + eol)
  fs.writeFileSync(full, lines.join('\n'), 'utf8')
  return { ok: true, reason: '', format: fmt }
}

/** 数一行 markdown 表格有几列；不是表格行返回 0。 */
function tableCells(line) {
  const s = String(line).trim()
  if (!s.startsWith('|')) return 0
  const inner = s.replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').length
}

/**
 * 往表格节末尾追加一行。
 *
 * 守三条，缺一条就拒绝并说清原因 —— 表格撑歪了读的人会当成真的：
 *   ① 内容本身要已经是表格行（以 `|` 开头）
 *   ② 列数必须和表头一致
 *   ③ 不能是 `|---|---|` 这种分隔行
 * 插到该表**最后一行之后**（不是节末尾），表格后面若还有正文不会被切断。
 */
function appendTableRow(full, lines, start, end, section, item) {
  const raw = String(item.text).replace(/\s+/g, ' ').trim()
  const where = section ? `「${section}」` : '这一节'

  if (!raw.startsWith('|')) {
    return {
      ok: false,
      reason: `${where}是表格节，要把内容写成一行表格：以 | 开头、列数与表头一致（例如 | 甲 | 乙 |）`,
    }
  }
  if (/^\|(\s*:?-{2,}:?\s*\|)+$/.test(raw)) {
    return { ok: false, reason: `${where}这是表头分隔行，不是数据行` }
  }

  // 表头 = 这一节里第一条表格行
  let header = -1
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i].trim().startsWith('|')) {
      header = i
      break
    }
  }
  if (header < 0) {
    return { ok: false, reason: `${where}里找不到表头，判断不了列数` }
  }

  const cols = tableCells(lines[header])
  const given = tableCells(raw)
  if (given !== cols) {
    return {
      ok: false,
      reason: `${where}是 ${cols} 列的表格，这条写成了 ${given} 列。请补齐或删掉多余的列，再提交一次。`,
    }
  }

  // 表格的最后一行（连续 `|` 行）
  let last = header
  for (let i = header + 1; i < end; i += 1) {
    if (lines[i].trim().startsWith('|')) last = i
    else break
  }

  lines.splice(last + 1, 0, raw + (lines[last].endsWith('\r') ? '\r' : ''))
  fs.writeFileSync(full, lines.join('\n'), 'utf8')
  return { ok: true, reason: '', format: 'table' }
}

/** 记忆库的完整路径（stem 可带可不带 .md）。 */
function libPath(memoryDir, stem) {
  const file = stem.endsWith('.md') ? stem : `${stem}.md`
  return { file, full: path.join(memoryDir, file) }
}

/**
 * 按一段原文片段在目标库里定位**唯一一行**。
 *
 * 返回 `{ ok, line（1 起）, original }` 或 `{ ok: false, reason }`。
 * 定位不到、命中多行都拒绝 —— 改写/删除是破坏性操作，
 * 宁可让模型再给一段更长的原文，也不替它猜是哪一行。
 */
export function resolveTarget(memoryDir, stem, match) {
  const { file, full } = libPath(memoryDir, stem)
  if (!fs.existsSync(full)) return { ok: false, reason: `目标文件不存在：${file}` }

  const lines = fs.readFileSync(full, 'utf8').split('\n')
  const raw = String(match).trim()
  const norm = raw.replace(/\s+/g, ' ')

  const hits = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(raw) || lines[i].replace(/\s+/g, ' ').includes(norm)) {
      hits.push(i)
    }
  }
  if (hits.length === 0) {
    return { ok: false, reason: `在 ${file} 里找不到「${raw.slice(0, 30)}」` }
  }
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `「${raw.slice(0, 30)}」命中 ${hits.length} 行，请给更长、更独特的片段`,
    }
  }
  return { ok: true, line: hits[0] + 1, original: lines[hits[0]] }
}

/**
 * 在文件里按**存下来的原文**重新定位那一行。
 *
 * 为什么不用行号：从提交到用户点「记住」之间，文件可能被别的会话改过，
 * 行号会漂；原文（整行逐字相等）不会漂。对不上就拒绝，绝不写到错的行上。
 */
function locateOriginal(lines, item) {
  const want = String((item.target && item.target.original) || '')
  if (!want) return -1
  return lines.findIndex((l) => l === want)
}

/**
 * 改写已有的一行。
 *
 * 前缀沿用**原来那一行**的（`- ` / 编号 / 表格竖线），不让格式跑掉：
 * 原来在编号列表里，改写后还是同一个编号；原来在表格里，必须还是同样的列数。
 */
export function replaceInMemory(memoryDir, item) {
  const { file, full } = libPath(memoryDir, item.stem)
  if (!fs.existsSync(full)) return { ok: false, reason: `目标文件不存在：${file}` }

  const lines = fs.readFileSync(full, 'utf8').split('\n')
  const idx = locateOriginal(lines, item)
  if (idx < 0) {
    return { ok: false, reason: '那一行已经变了（可能被别处改过），请重新提交' }
  }

  const old = lines[idx]
  const trimmed = old.trim()

  // 模型常把前缀也一起写进来，先剥掉，再由原行决定加什么前缀
  const body = String(item.text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.、)]\s+/, '')
  if (!body) return { ok: false, reason: '内容为空' }

  let line
  const num = /^(\d+)([.、)])\s+/.exec(trimmed)
  if (/^[-*]\s/.test(trimmed)) {
    line = `- ${body}`
  } else if (num) {
    line = `${num[1]}${num[2]} ${body}`
  } else if (trimmed.startsWith('|')) {
    const cells = trimmed.split('|').length
    const given = String(item.text).trim().split('|').length
    if (!String(item.text).trim().startsWith('|') || cells !== given) {
      return {
        ok: false,
        reason: `这一行是表格行（${cells - 2} 列），改写要给完整的整行且列数不变`,
      }
    }
    line = String(item.text).trim()
  } else {
    line = body
  }

  lines[idx] = line + (old.endsWith('\r') ? '\r' : '')
  fs.writeFileSync(full, lines.join('\n'), 'utf8')
  return { ok: true, reason: '', format: 'replace' }
}

/**
 * 删掉已有的一行。
 *
 * 编号节删完把后面的编号顺延，避免出现 1 2 4 5 这种空号。
 * 只重排**被删位置之后**的编号，前面的保持原样。
 */
export function deleteInMemory(memoryDir, item) {
  const { file, full } = libPath(memoryDir, item.stem)
  if (!fs.existsSync(full)) return { ok: false, reason: `目标文件不存在：${file}` }

  const lines = fs.readFileSync(full, 'utf8').split('\n')
  const idx = locateOriginal(lines, item)
  if (idx < 0) {
    return { ok: false, reason: '那一行已经变了（可能被别处改过），请重新提交' }
  }

  const old = lines[idx]
  const wasNumbered = /^\d+[.、)]\s+/.test(old.trim())

  // 先记住所在节的起点（splice 之后索引会变，所以现在算）
  let secStart = -1
  if (wasNumbered) {
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (lines[i].startsWith('## ')) {
        secStart = i
        break
      }
    }
  }

  lines.splice(idx, 1)

  if (wasNumbered) {
    let n = 0
    for (let i = secStart + 1; i < idx; i += 1) {
      const m = /^(\d+)[.、)]\s+/.exec(lines[i].trim())
      if (m) n = Number(m[1])
    }
    for (let i = idx; i < lines.length; i += 1) {
      if (lines[i].startsWith('## ')) break
      const m = /^(\d+)([.、)])\s+/.exec(lines[i].trim())
      if (!m) continue
      n += 1
      lines[i] = lines[i].replace(
        /^(\s*)\d+([.、)])\s+/,
        (all, ws, dot) => `${ws}${n}${dot} `,
      )
    }
  }

  fs.writeFileSync(full, lines.join('\n'), 'utf8')
  return { ok: true, reason: '', format: 'delete' }
}

/** 在库里挑最贴近的章节（模型没给章节时用）。 */
function bestSection(lib, text) {
  if (!lib) return ''
  const q = tokenSet(text)
  let best = null
  let bestScore = -1
  for (const sec of lib.sections) {
    if (sec.meta) continue
    let s = overlap(q, sec.titleTokens || tokenSet(sec.title)) * 6
    s += overlap(q, sec.bodyTokens || new Set()) * 1.5
    if (s > bestScore) {
      bestScore = s
      best = sec
    }
  }
  return best ? best.title : ''
}

const STOP_HAN = new Set(
  '的了是我你他在有和就不都一个上也很到说要去会着没有看好这那什么怎么怎样能吗呢吧啊把被对为与及其之以可为而已在于那就',
)

function tokenSet(text) {
  const out = new Set()
  const lower = String(text || '').toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9_\-./]{2,}/g)) out.add(m[0])
  for (const seg of lower.split(/[^\u4e00-\u9fff]+/)) {
    for (let i = 0; i < seg.length - 1; i += 1) {
      const bg = seg.slice(i, i + 2)
      if (!STOP_HAN.has(bg[0]) && !STOP_HAN.has(bg[1])) out.add(bg)
    }
  }
  return out
}

function overlap(a, b) {
  if (!a || !b || !a.size || !b.size) return 0
  let n = 0
  for (const t of a) if (b.has(t)) n += 1
  return n / a.size
}

// ── 小工具 ───────────────────────────────────────────────

function writeJson(res, obj) {
  try {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(obj))
  } catch {
    /* noop */
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (typeof b === 'string') parts.push(b)
    else if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join(' ').trim()
}
