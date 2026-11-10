// 写入侧通用性（新版）：下拉目标来自实际扫描到的库。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyWriteMode } from '../lib/write-mode.js'
import { deriveIndex } from '../index.js'
import { makeFakeCtx } from './fake-ctx.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-tg-'))
process.env.USERPROFILE = home
process.env.HOME = home

function scene(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-sc-'))
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c, 'utf8')
  console.log()
  console.log('─'.repeat(74))
  console.log(name)
  console.log('─'.repeat(74))

  const ctx = makeFakeCtx()
  applyWriteMode(ctx, { memoryDir: dir, deriveIndex, debug: false })

  const res = {
    _b: '',
    writeHead() {},
    end(s) { this._b = s },
  }
  ctx.routes['/almost-for-ever/pending']({}, res)
  const data = JSON.parse(res._b)
  const targets = data.targets || []

  const actual = deriveIndex(dir).map((l) => l.stem)
  console.log(`  用户实际的库: [${actual.join(', ')}]`)
  console.log(`  下拉目标 (${targets.length}):`)
  for (const t of targets.slice(0, 8)) {
    console.log(`    ${t.stem.padEnd(22)} ${t.label}`)
  }
  const missing = actual.filter((a) => !targets.some((t) => t.stem === a))
  const phantom = targets.filter((t) => !actual.includes(t.stem))
  console.log(`  用户有但下拉没有: [${missing.join(', ') || '无'}]`)
  console.log(`  下拉有但用户没有: [${phantom.map((p) => p.stem).join(', ') || '无'}]`)
  console.log(missing.length === 0 && phantom.length === 0 ? '  ✅ 完全对齐' : '  ❌ 不对齐')

  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('='.repeat(74))
console.log('写入侧：下拉目标是否跟着用户的库走')
console.log('='.repeat(74))

scene('A 小白：中文随手记', {
  'notes.md': `# 我的笔记
- 猫叫咪咪
- 周五交报告
`,
})

scene('B 别人：英文库', {
  'preferences.md': `# Preferences
## Communication
- Prefers concise answers
`,
  'projects.md': `# Projects
## Website
- React 18
`,
})

scene('C 作者自己：13+ 库', {
  '02-preferences.md': `# 偏好
<!-- 标签: 偏好 -->
## 边界与安全
- 测试
`,
  '09-windows-cmd.md': `# 命令
<!-- 标签: 命令 -->
## 白名单
- 测试
`,
})

scene('D 空目录', {})

fs.rmSync(home, { recursive: true, force: true })
