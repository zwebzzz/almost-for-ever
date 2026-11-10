// 写入模式：让模型自己审视，而不是用规则猜。
//
// 设计（实测支撑）：
//   ① 规则猜「该写进哪本书」准确率只有 30%（留出验证），
//      为了补到可用堆了 400 行启发式规则 —— 那是在手工复刻模型本来就会做的事。
//   ② 模型已经读过整个对话，回头看不需要重新喂上下文，成本极低。
//   ③ 触发时机：每 N 轮（默认 7）自动审视一次；用户说「记一下」时立刻审视。
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
    '可以写进这些库（第一个词就是库名）：',
    libList,
  ].join('\n')
}

/** 用户说了记录口令 —— 立刻审视一次。 */
const REMEMBER_CUE = /记一下|记住|记下来|记着|写进记忆|记录一下|存进记忆|做好索引/

// ── 注册入口 ─────────────────────────────────────────────

export function applyWriteMode(ctx, config = {}) {
  const deriveIndex = config.deriveIndex
  const memoryDir =
    config.memoryDir ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'memory')
  const writeEnabled = config.writeEnabled !== false
  const debug = config.debug === true

  // 触发间隔：可以按「轮数」也可以按「token 数」。
  //   intervalUnit  = 'turns'（默认）| 'tokens'
  //   intervalValue = 该单位下的阈值
  // 向后兼容：老的 everyTurns 仍然生效。
  const intervalUnit = config.intervalUnit === 'tokens' ? 'tokens' : 'turns'
  const intervalValue = Number.isFinite(config.intervalValue)
    ? config.intervalValue
    : intervalUnit === 'tokens'
      ? 20000
      : Number.isFinite(config.everyTurns)
        ? config.everyTurns
        : 7

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
            counters.set(session, (counters.get(session) || 0) + 1)
            if (shouldFire(session)) {
              pendingNudge.set(session, 'auto')
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
                pendingNudge.set(session, 'auto')
                debugLog({ ev: 'nudge-scheduled', unit: 'tokens',
                  at: intervalValue, total: add }, debug)
              }
            }
          }
        }

        if (event.type === 'user/message') {
          const msg = event.data && (event.data.message || event.data)
          const text = contentToText(msg && msg.content)
          if (text && REMEMBER_CUE.test(text)) {
            pendingNudge.set(session, 'cue')
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
        text: (assembleContext) => {
          try {
            if (!writeEnabled) return ''
            const scope = assembleContext && assembleContext.scope
            if (!scope || typeof scope !== 'object') return ''
            const why = pendingNudge.get(scope)
            if (!why) return ''
            // 只提示一次，避免每个 step 都重复
            pendingNudge.delete(scope)
            const text = buildNudge(libs())
            debugLog({ ev: 'nudge-injected', why, len: text.length }, debug)
            return text
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
          '点「不要」或「全部忽略」则丢弃。只在确实有下次还用得上的东西时才调用。',
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
                    description: '一句话、独立可读，不依赖上下文指代',
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
                },
                required: ['text'],
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
            },
          },
          render(args, value) {
            const n = (value && value.count) || 0
            return [
              {
                type: 'text',
                text: n
                  ? `已提交 ${n} 条候选，等用户在弹窗里确认后才会写入记忆库。`
                  : '没有提交任何候选。',
              },
            ]
          },
        },
        async execute(args) {
          const list = Array.isArray(args && args.candidates) ? args.candidates : []
          const known = libs()
          const queue = loadQueue()
          let added = 0

          for (const c of list) {
            const text = String((c && c.text) || '').replace(/\s+/g, ' ').trim()
            if (!text || text.length > 400) continue
            if (queue.some((q) => q.text === text)) continue

            const kind = KIND_LABEL[c && c.kind] ? c.kind : 'fact'
            const stem = normalizeLib(c && c.lib, known)
            const sec = stem
              ? bestSection(known.find((l) => l.stem === stem), text)
              : ''

            queue.push({
              id: nextId(),
              text,
              kind,
              score: 0,
              why: String((c && c.why) || '').slice(0, 120),
              stem,
              section: sec,
              where: stem ? labelOf(stem) : '',
              createdAt: Date.now(),
            })
            added += 1
          }

          saveQueue(queue.slice(-40))
          debugLog({ ev: 'propose', offered: list.length, added }, debug)
          return { count: added, accepted: list.length }
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
              text: c.text,
              kind: c.kind,
              kindLabel: KIND_LABEL[c.kind] || '其它',
              guessed: c.stem || '',
              guessedLabel: c.stem ? labelOf(c.stem) : '',
              where: c.where || '',
              why: c.why || '',
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
              saveQueue(loadQueue().filter((c) => c.id !== id))
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

    const result = appendToMemory(memoryDir, item)
    if (result.ok) saveQueue(queue.filter((c) => c.id !== id))
    debugLog(
      { ev: 'accept', ok: result.ok, stem: item.stem,
        format: result.format, reason: result.reason,
        text: item.text.slice(0, 40) },
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
 *   table     → **拒绝**（表格列数/对齐必须人判断，插件不猜）
 * 没指定库就落到 02-preferences。
 *
 * 返回 { ok, reason }。
 */
function appendToMemory(memoryDir, item) {
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

  // 表格节：拒绝自动写入 —— 列数、对齐、表头都得人判断
  if (fmt === 'table') {
    return {
      ok: false,
      reason: `「${section}」是表格，插件不猜列结构。请手动写这一行，或换一个非表格的节。`,
    }
  }

  // 定位插入点
  let insertAt = end
  while (insertAt > (start >= 0 ? start + 1 : 0) && lines[insertAt - 1].trim() === '') {
    insertAt -= 1
  }

  const oneLine = String(item.text).replace(/\s+/g, ' ').trim()
  if (!oneLine) return { ok: false, reason: '内容为空' }

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

  lines.splice(insertAt, 0, line)
  fs.writeFileSync(full, lines.join('\n'), 'utf8')
  return { ok: true, reason: '', format: fmt }
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
