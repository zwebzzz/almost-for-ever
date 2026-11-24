// memory_propose 的 section 字段（2026-11-24 外快会话踩到的死循环修复）。
//
// 死循环复盘：04-projects 是多表库（「拆到哪了」2 列 +「缺口」3 列），
// 候选无 section 时 bestSection 按词面重叠猜节、零重叠默认第一张表 →
// 按 A 表写被 B 表列数卡、按 B 表写被 A 表卡，改列数重提猜节又变，来回驳回。
//
// 修法：候选可带显式 section（当场校验节名存在）；bestSection 兜底但零重叠不再硬猜。
// 全部在临时目录里跑，不碰 ~/.dsh。
// ⚠️ 场景间用独立库文件隔离：落库后的正文会进索引 token 空间，
//    前一场景落的行会让后一场景的候选「有重叠」，零重叠前提就没了。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyWriteMode } from '../lib/write-mode.js'
import { deriveIndex } from '../index.js'

const MEM = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-sec-mem-'))
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-sec-home-'))
process.env.USERPROFILE = HOME
process.env.HOME = HOME

// 库 A：多表库，复刻 04-projects 的死循环结构（2 列表 + 3 列表）
const LIBA = '04-projects'
// 库 B：干净的多表库，专测零重叠 / 兜底猜节（无先前落库污染 token 空间）
const LIBB = '04-clean'
const TEMPLATE = `# 项目

## 拆到哪了

| 项目 | 位置 |
| --- | --- |
| 卡牌游戏 | E:/game-a |

## 缺口（2026-11-09 发现）

| 缺口 | 状态 | 备注 |
| --- | --- | --- |
| 外快渠道 | 待补 | 无 |
`
fs.writeFileSync(path.join(MEM, `${LIBA}.md`), TEMPLATE, 'utf8')
fs.writeFileSync(path.join(MEM, `${LIBB}.md`), TEMPLATE, 'utf8')

const routes = {}
const tools = []
const ctx = {
  effect(fn) {
    return fn()
  },
  on() {
    return () => {}
  },
  inject(deps, cb) {
    cb({
      effect(fn) {
        return fn()
      },
      on() {
        return () => {}
      },
      webServer: {
        register: (r) => {
          routes[r.path] = r.handler
          return () => {}
        },
      },
      tools: {
        register: (d) => {
          tools.push(d)
          return () => {}
        },
      },
      systemPrompt: { context: () => () => {} },
    })
  },
  get() {
    return undefined
  },
  systemPrompt: {
    context() {
      return () => {}
    },
  },
}

applyWriteMode(ctx, { memoryDir: MEM, deriveIndex, debug: false })
const tool = tools.find((t) => t.name === 'memory_propose')

function fakeReq(body) {
  const h = {}
  const req = {
    on(n, fn) {
      h[n] = fn
      return req
    },
    destroy() {},
  }
  setImmediate(() => {
    if (h.data) h.data(JSON.stringify(body))
    if (h.end) h.end()
  })
  return req
}
function fakeRes() {
  return {
    _b: '',
    writeHead() {},
    end(s) {
      this._b = s
    },
  }
}
async function call(routePath, body) {
  const res = fakeRes()
  routes[routePath](fakeReq(body), res)
  for (let i = 0; i < 50 && !res._b; i += 1) await new Promise((r) => setTimeout(r, 10))
  return JSON.parse(res._b || '{}')
}

let pass = 0
let total = 0
function ok(name, cond, extra) {
  total += 1
  if (cond) {
    pass += 1
  } else {
    console.log('  ✗ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)))
  }
}

// 提交一条候选，返回它在队列里的 id（只 accept 这一条，不碰滞留候选）
async function proposeOne(cand) {
  const r = await tool.execute({ candidates: [cand] })
  const pending = await call('/almost-for-ever/pending', {})
  const item = pending.items[pending.items.length - 1]
  return { r, id: item ? item.id : '', item }
}
async function acceptOne(id, stem) {
  return call('/almost-for-ever/accept', { id, stem: stem || '' })
}

// ── 1. 显式 section「拆到哪了」+ 2 列行 → 落进正确的表 ──
{
  const { r, id } = await proposeOne({
    text: '| 外快 | E:/waikuai |', lib: LIBA, kind: 'fact', section: '拆到哪了',
  })
  ok('1a 显式 section 提交进队列', r.count === 1, r)
  const res = await acceptOne(id, LIBA)
  ok('1b 落进「拆到哪了」2 列表', res.ok === true, res)
  const body = fs.readFileSync(path.join(MEM, `${LIBA}.md`), 'utf8')
  ok('1c 2 列表末尾多了外快行', body.includes('| 卡牌游戏 | E:/game-a |\n| 外快 | E:/waikuai |'), body)
}

// ── 2. 显式 section「缺口」+ 3 列行 → 落进 3 列表 ──
{
  const { r, id } = await proposeOne({
    text: '| 视频号 | 待试 | 无 |', lib: LIBA, kind: 'fact', section: '缺口',
  })
  ok('2a 提交', r.count === 1, r)
  const res = await acceptOne(id, LIBA)
  ok('2b 落进「缺口」3 列表', res.ok === true, res)
  const body = fs.readFileSync(path.join(MEM, `${LIBA}.md`), 'utf8')
  ok('2c 3 列表末尾多了行', body.includes('| 外快渠道 | 待补 | 无 |\n| 视频号 | 待试 | 无 |'), body)
}

// ── 3. 显式 section + 列数不匹配 → 驳回消息指向**模型指定的节**（改一次列数就能过）──
{
  const { r, id } = await proposeOne({
    text: '| 闲鱼 | E:/xy |', lib: LIBA, kind: 'fact', section: '缺口',
  })
  ok('3a 提交', r.count === 1, r)
  const res = await acceptOne(id, LIBA)
  ok('3b 被驳回', res.ok === false, res)
  ok('3c 驳回说的是「缺口」节（=模型指定的那个）', res.reason && res.reason.includes('缺口'), res)
  ok('3d 驳回说的是 3 列', res.reason && res.reason.includes('3 列'), res)
}

// ── 4. 真拼错的 section → 提交当场 skipped（带可选节名），不进队列 ──
{
  const r = await tool.execute({
    candidates: [{ text: '| 闲鱼2 | E:/xy2 |', lib: LIBA, kind: 'fact', section: '拆哪儿' }],
  })
  ok('4a 拼错节名被跳过', r.count === 0 && (r.skipped || []).length === 1, r)
  ok(
    '4b 提示列出可选节名',
    (r.skipped || [])[0] && r.skipped[0].includes('拆到哪了') && r.skipped[0].includes('缺口'),
    r.skipped,
  )
}

// ── 5. 干净库：无 section 且零重叠 → 不硬猜第一节，落尾 bullet 不死循环 ──
{
  const { r, id } = await proposeOne({
    text: '| 阿稳 | E:/xy3 |', lib: LIBB, kind: 'fact',
  })
  ok('5a 零重叠候选进队列', r.count === 1, r)
  const res = await acceptOne(id, LIBB)
  ok('5b 落库不再被 3 列表校验驳回（不死循环）', res.ok === true, res)
  const body = fs.readFileSync(path.join(MEM, `${LIBB}.md`), 'utf8')
  ok('5c 落在文件尾（没塞进任何表）', body.trim().endsWith('- | 阿稳 | E:/xy3 |'), body)
}

// ── 6. 干净库：有词面重叠、无显式 section → bestSection 兜底仍工作 ──
{
  const { r, id } = await proposeOne({
    text: '| 卡牌游戏 | 已完 |', lib: LIBB, kind: 'fact',
  })
  ok('6a 有重叠候选进队列', r.count === 1, r)
  const res = await acceptOne(id, LIBB)
  ok('6b 兜底猜节落库成功', res.ok === true, res)
  const body = fs.readFileSync(path.join(MEM, `${LIBB}.md`), 'utf8')
  ok('6c 落进了「拆到哪了」节内（猜节正确）', /## 拆到哪了[\s\S]*\| 卡牌游戏 \| 已完 \|[\s\S]*## 缺口/.test(body), body)
}

fs.rmSync(MEM, { recursive: true, force: true })
fs.rmSync(HOME, { recursive: true, force: true })

console.log(`\n${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
