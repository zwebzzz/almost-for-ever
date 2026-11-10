// 起手模板测试：生成、不覆盖、检索可用。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyWriteMode } from '../lib/write-mode.js'
import { deriveIndex, search } from '../index.js'
import { buildPreset, PRESET_NAMES } from '../lib/presets.js'
import { makeFakeCtx } from './fake-ctx.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-pr-'))
process.env.USERPROFILE = home
process.env.HOME = home

console.log('='.repeat(74))
console.log('① 三种模板各长什么样')
console.log('='.repeat(74))
for (const name of PRESET_NAMES) {
  const files = buildPreset(name)
  console.log(`\n  【${name}】${files.length} 个文件:`)
  for (const f of files) {
    const lines = f.content.split('\n').length
    console.log(`    ${f.file.padEnd(24)} ${lines} 行`)
  }
}

console.log()
console.log('='.repeat(74))
console.log('② 生成到空目录')
console.log('='.repeat(74))

const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-mem-'))
const ctx = makeFakeCtx()
applyWriteMode(ctx, { memoryDir: memDir, deriveIndex, debug: false })

function call(pathName, body) {
  return new Promise((resolve) => {
    const listeners = {}
    const req = { on(e, cb) { listeners[e] = cb; return req }, destroy() {} }
    const res = {
      _b: '',
      writeHead() {},
      end(s) { this._b = s; resolve(JSON.parse(s)) },
    }
    ctx.routes[pathName](req, res)
    setImmediate(() => {
      if (listeners.data) listeners.data(Buffer.from(JSON.stringify(body)))
      if (listeners.end) listeners.end()
    })
  })
}

const r1 = await call('/almost-for-ever/scaffold', { preset: 'minimal' })
console.log(`  生成: ${r1.created && r1.created.length} 个文件`)
for (const f of r1.created || []) console.log(`    + ${f}`)

console.log()
console.log('='.repeat(74))
console.log('③ 再生成一次（绝不能覆盖）')
console.log('='.repeat(74))
const r2 = await call('/almost-for-ever/scaffold', { preset: 'minimal' })
console.log(`  新建: ${(r2.created || []).length}  跳过: ${(r2.skipped || []).length}`)
for (const f of r2.skipped || []) console.log(`    = ${f}`)
console.log((r2.created || []).length === 0 ? '  ✅ 一个字都没覆盖' : '  ❌ 覆盖了')

console.log()
console.log('='.repeat(74))
console.log('④ 生成出来的库能不能检索')
console.log('='.repeat(74))
const libs = deriveIndex(memDir)
console.log(`  派生 ${libs.length} 个库`)
for (const q of ['我的偏好是什么', '我喜欢什么样的回答', '项目做到哪了']) {
  const r = search(libs, q, 2)
  console.log(`    「${q}」→ ${r.hits.length ? `${r.hits[0].lib.stem} :: ${r.hits[0].sec.title}` : '无命中'}`)
}

console.log()
console.log('='.repeat(74))
console.log('⑤ 加更多库（full）')
console.log('='.repeat(74))

// 换成新目录，测 full
const memDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-mem2-'))
const ctx2 = makeFakeCtx()
applyWriteMode(ctx2, { memoryDir: memDir2, deriveIndex, debug: false })
const r3 = await new Promise((resolve) => {
  const listeners = {}
  const req = { on(e, cb) { listeners[e] = cb; return req }, destroy() {} }
  const res = { _b: '', writeHead() {}, end(s) { resolve(JSON.parse(s)) } }
  ctx2.routes['/almost-for-ever/scaffold'](req, res)
  setImmediate(() => {
    if (listeners.data) listeners.data(Buffer.from(JSON.stringify({ preset: 'full' })))
    if (listeners.end) listeners.end()
  })
})
console.log(`  full 生成 ${(r3.created || []).length} 个文件`)
const libs2 = deriveIndex(memDir2)
console.log(`  派生 ${libs2.length} 个库: ${libs2.map((l) => l.stem).join(', ')}`)

fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(memDir, { recursive: true, force: true })
fs.rmSync(memDir2, { recursive: true, force: true })
