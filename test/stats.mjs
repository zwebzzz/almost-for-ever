// 「记忆」标签页的数据链路：轮次计数 / 注入计数 / 统计接口 / 设置读写。
//
// 全部在临时目录里跑：不读真实记忆库，也不碰 ~/.dsh。
// 不需要 DSH_MEMORY_DIR。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyWriteMode, noteReadHits } from '../lib/write-mode.js'
import { deriveIndex } from '../index.js'

const MEM = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-stats-mem-'))
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-stats-home-'))
process.env.USERPROFILE = HOME
process.env.HOME = HOME

fs.writeFileSync(
  path.join(MEM, '02-preferences.md'),
  `# 偏好

## 一、沟通

- 说话直接一点
- 不要问废话
`,
  'utf8',
)
fs.writeFileSync(
  path.join(MEM, '05-environment.md'),
  `# 环境

## 一、磁盘

| 盘 | 用途 |
|----|------|
| C: | 系统 |
`,
  'utf8',
)

const routes = {}
const tools = []
const handlers = {}
let nudgeOpts = null

const subCtx = {
  effect: (fn) => fn(),
  on: (name, fn) => {
    handlers[name] = fn
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
}

const ctx = {
  effect: (fn) => fn(),
  on: (name, fn) => {
    handlers[name] = fn
    return () => {}
  },
  inject: (deps, cb) => cb(subCtx),
  get: () => undefined,
  systemPrompt: {
    // 按名字取「提醒」那一个：插件注册了不止一个 context provider
    // （almost-for-ever-nudge 是提醒，almost-for-ever-revise 是「说两句」的要求）
    context(opts) {
      if (!opts || opts.name !== 'almost-for-ever-revise') nudgeOpts = opts
      return () => {}
    },
  },
}

applyWriteMode(ctx, { memoryDir: MEM, deriveIndex, debug: false })

function fakeReq(body, url) {
  const h = {}
  const req = {
    url: url || '/',
    method: body === undefined ? 'GET' : 'POST',
    on(n, fn) {
      h[n] = fn
      return req
    },
    destroy() {},
  }
  setImmediate(() => {
    if (h.data) h.data(JSON.stringify(body === undefined ? {} : body))
    if (h.end) h.end()
  })
  return req
}
const fakeRes = () => ({ _b: '', writeHead() {}, end(s) { this._b = s } })

async function call(routePath, body, url) {
  const res = fakeRes()
  routes[routePath](fakeReq(body, url), res)
  for (let i = 0; i < 50 && !res._b; i += 1) await new Promise((r) => setTimeout(r, 10))
  return JSON.parse(res._b || '{}')
}

let pass = 0
let total = 0
function check(name, ok, extra) {
  total += 1
  if (ok) pass += 1
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}

const session = { id: 'S1' }
const emit = (type, data) => handlers['session/event'](session, { type, data })
const stats = () => call('/almost-for-ever/stats', undefined, '/almost-for-ever/stats?session=S1')

console.log('='.repeat(66))
console.log('统计与设置')
console.log('='.repeat(66))

emit('turn/start', { turn: 1 })
emit('turn/start', { turn: 2 })
let s = await stats()
check('turns 计数', s.session && s.session.turns === 2)
check('2 轮时还没安排审视', s.session && s.session.scheduled === 0)

emit('turn/start', { turn: 3 })
s = await stats()
check('第 3 轮安排审视', s.session && s.session.scheduled === 1)

const t1 = nudgeOpts.text({ scope: { session } })
const t2 = nudgeOpts.text({ scope: { session } })
check('注入文本非空', typeof t1 === 'string' && t1.length > 100, `len=${t1.length}`)
check('两次调用同一份（幂等）', t1 === t2)
s = await stats()
check('injected 只记一次', s.session && s.session.injected === 1)

noteReadHits(session, [{ stem: '02-preferences' }, { stem: '05-environment' }], 320)
s = await stats()
check('读侧命中记账', s.session && s.session.hits === 1)
check('命中库带白话名', s.session && s.session.hitLibs[0].label.length > 0,
  s.session && s.session.hitLibs.map((x) => `${x.stem}×${x.count}`).join(' '))

const tool = tools.find((t) => t.name === 'memory_propose')
const out = await tool.execute({ candidates: [{ text: '探针写的一条', kind: 'fact', lib: '02-preferences' }] })
check('提交候选', out && out.count === 1)
const pending = await call('/almost-for-ever/pending')
await call('/almost-for-ever/accept', { id: pending.items[0].id, stem: '02-preferences' })
s = await stats()
check('接受后 global.accepted = 1', s.global.accepted === 1)

check('记忆库一览按体积排序', s.libs.length === 2 && s.libs[0].tokens >= s.libs[1].tokens)
check('总 token > 0', s.totalTokens > 0)

let cur = await call('/almost-for-ever/settings')
check('默认间隔 3', cur.settings.intervalValue === 3)
check('默认写入开 / 浮层开', cur.settings.writeEnabled === true && cur.settings.chips === true)

const patched = await call('/almost-for-ever/settings', { intervalValue: 7, chips: false })
check('改设置立刻生效', patched.settings.intervalValue === 7 && patched.settings.chips === false)
s = await stats()
check('stats 跟着变', s.interval.value === 7 && s.settings.chips === false)

const settingsPath = path.join(HOME, '.dsh', 'almost-for-ever', 'settings.json')
check('设置已落盘', fs.existsSync(settingsPath))
if (fs.existsSync(settingsPath)) {
  const disk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  check('盘上只存改过的字段', disk.intervalValue === 7 && disk.chips === false && !('debug' in disk))
}

const clamped = await call('/almost-for-ever/settings', { intervalValue: 999 })
check('越界值被夹住', clamped.settings.intervalValue === 100)

s = await stats()
check('最近活动有记录', Array.isArray(s.recent) && s.recent.length > 0)
check('最近活动按时间倒序', s.recent.length > 1 && s.recent[0].at >= s.recent[s.recent.length - 1].at)

fs.rmSync(MEM, { recursive: true, force: true })
fs.rmSync(HOME, { recursive: true, force: true })

console.log('='.repeat(66))
console.log(`结果：${pass}/${total} 通过`)
console.log('='.repeat(66))
process.exit(pass === total ? 0 : 1)
