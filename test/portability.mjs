// 改进后的通用性测试：用「用户会问的话」而不是固定 4 句。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveIndex, search, renderHits, tokenize } from '../index.js'

function build(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-p-'))
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c, 'utf8')
  return dir
}

const SCENES = [
  {
    name: 'C 没章节（小白随手记）',
    files: {
      'notes.md': `# 我的笔记
- 喜欢喝美式
- 猫叫咪咪
- 周五要交报告
`,
    },
    queries: ['猫叫什么名字', '我喜欢喝什么', '周五要做什么'],
  },
  {
    name: 'D 英文库 + 英文查询',
    files: {
      'preferences.md': `# Preferences
<!-- 标签: preferences -->

## Communication
- Prefers concise answers
- No emoji
`,
    },
    queries: ['what are my preferences', 'how should i communicate', 'emoji'],
  },
  {
    name: 'E 中文异库名',
    files: {
      '工作日志.md': `# 工作日志
## 客户 A 项目
- 需求：小程序改版
- 截止：下月底
`,
      '生活.md': `# 生活
## 健康
- 每天走 8000 步
`,
    },
    queries: ['客户 A 要做什么', '每天走多少步', '小程序', '健康'],
  },
  {
    name: 'G 全无标签无章节（最糟情况）',
    files: {
      'stuff.md': `just some notes
remember to buy milk
the wifi password is hunter2
`,
    },
    queries: ['wifi password', 'what to buy'],
  },
]

console.log('='.repeat(78))
console.log('改进后：用户自己的问法')
console.log('='.repeat(78))

let total = 0
let hit = 0

for (const scene of SCENES) {
  const dir = build(scene.files)
  const libs = deriveIndex(dir)
  console.log()
  console.log(`【${scene.name}】`)
  console.log(`  派生 ${libs.length} 库:`)
  for (const l of libs) {
    console.log(`    ${l.stem.padEnd(16)} ${l.sections.length} 节  标签=[${[...l.tags].slice(0, 8).join(',')}]`)
  }

  for (const q of scene.queries) {
    total += 1
    const r = search(libs, q, 2)
    if (r.hits.length) {
      hit += 1
      const rendered = renderHits(r, tokenize(q))
      console.log(`    ✓ 「${q}」→ ${r.hits[0].lib.stem} :: ${r.hits[0].sec.title.slice(0, 30)}  (注入 ${rendered.length} 字符)`)
    } else {
      console.log(`    ✗ 「${q}」→ 无命中`)
    }
  }

  fs.rmSync(dir, { recursive: true, force: true })
}

console.log()
console.log('='.repeat(78))
console.log(`通用命中率 ${hit}/${total} = ${Math.round((hit / total) * 100)}%`)
console.log('='.repeat(78))
