// 弹窗第三个选项「说两句」：用户说一句话 → 下一轮带给模型 → 模型改写或撤掉。
//
// 全部在临时目录里跑：不读真实记忆库，也不碰 ~/.dsh。
// 不需要 DSH_MEMORY_DIR。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyWriteMode } from '../lib/write-mode.js'
import { deriveIndex } from '../index.js'

const MEM = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-revise-mem-'))
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-revise-home-'))
process.env.USERPROFILE = HOME
process.env.HOME = HOME

const LIB = '02-preferences'
fs.writeFileSync(
  path.join(MEM, `${LIB}.md`),
  `# 偏好

## 一、沟通

- 已经存在的一条
`,
  'utf8',
)

const routes = {}
const tools = []
const providers = []
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
    context(entry) {
      providers.push(entry)
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

const reviseProvider = providers.find((p) => p.name === 'almost-for-ever-revise')
const textOf = () => {
  try {
    return reviseProvider ? String(reviseProvider.text({}) || '') : ''
  } catch {
    return ''
  }
}

// 1. 没有要求时不占上下文
ok('provider 已注册', !!reviseProvider)
ok('order = 57', reviseProvider && reviseProvider.order === 57, reviseProvider && reviseProvider.order)
ok('没有要求时文本为空', textOf() === '', textOf().slice(0, 80))

// 2. 挂上要求
await tool.execute({ candidates: [{ text: '这条有点长，先放着', lib: LIB, kind: 'pref' }] })
let pending = await call('/almost-for-ever/pending', {})
ok('队列 1 条', pending.items.length === 1, pending.items.length)
const first = pending.items[0]
ok('pending 带 note 字段（空）', first && first.note === '', first && first.note)

const rev = await call('/almost-for-ever/revise', { id: first.id, note: '太长了，压成一句' })
ok('revise 返回 ok', rev.ok === true, rev)
pending = await call('/almost-for-ever/pending', {})
ok('pending 里能看到要求', pending.items[0].note === '太长了，压成一句', pending.items[0].note)

// 3. 要求进了上下文
const text = textOf()
ok('注入文本非空', text.length > 0, text.length)
ok('带候选 id', text.includes('#' + first.id), text.slice(0, 120))
ok('带用户原话', text.includes('太长了，压成一句'))
ok('带 reviseOf 指引', text.includes('reviseOf'))
ok('带 drop 指引', text.includes('drop'))

// 4. 模型带 reviseOf 重新提交 → 原候选被撤掉
const r2 = await tool.execute({
  candidates: [{ text: '这条要短。', lib: LIB, kind: 'pref', reviseOf: first.id }],
})
ok('提交了 1 条', r2.count === 1, r2)
pending = await call('/almost-for-ever/pending', {})
ok('队列仍是 1 条（原候选已撤）', pending.items.length === 1, pending.items.length)
ok('是新那条', pending.items[0].text === '这条要短。', pending.items[0].text)
ok('原 id 不在了', pending.items.every((x) => x.id !== first.id))
ok('要求处理后注入文本变空', textOf() === '', textOf().slice(0, 80))

// 5. 模型判断「不该记」→ op:"drop"
await tool.execute({ candidates: [{ text: '这条不该记', lib: LIB, kind: 'fact' }] })
pending = await call('/almost-for-ever/pending', {})
ok('队列 2 条', pending.items.length === 2, pending.items.length)
const second = pending.items.find((x) => x.text === '这条不该记')
await call('/almost-for-ever/revise', { id: second.id, note: '这个别记了' })
ok('要求已挂上', textOf().includes('这个别记了'))
const r3 = await tool.execute({ candidates: [{ op: 'drop', reviseOf: second.id }] })
ok('dropped = 1', r3.dropped === 1, r3)
pending = await call('/almost-for-ever/pending', {})
ok('队列回到 1 条', pending.items.length === 1, pending.items.length)
ok('注入文本再次变空', textOf() === '')

// 6. 边界：不存在的 reviseOf、空 note 撤回
const r4 = await tool.execute({ candidates: [{ op: 'drop', reviseOf: 'c-nope' }] })
ok('不存在的 reviseOf 被跳过', (r4.skipped || []).length === 1, r4)
const keep = pending.items[0]
await call('/almost-for-ever/revise', { id: keep.id, note: '随便说说' })
ok('挂上了', textOf().includes('随便说说'))
await call('/almost-for-ever/revise', { id: keep.id, note: '' })
ok('空 note = 撤回', textOf() === '', textOf().slice(0, 80))

// 7. 带 reviseOf 时允许与已有条目同文（用户只是让换个说法或换库）
const r5 = await tool.execute({
  candidates: [{ text: '已经存在的一条', lib: LIB, kind: 'pref', reviseOf: keep.id }],
})
ok('带 reviseOf 时不被去重挡掉', r5.count === 1, r5)

fs.rmSync(MEM, { recursive: true, force: true })
fs.rmSync(HOME, { recursive: true, force: true })

console.log(`${pass}/${total} 通过`)
process.exit(pass === total ? 0 : 1)
