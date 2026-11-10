// 测试格式探测：直接 import 插件真实实现，不复制逻辑。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectSectionFormat } from '../lib/write-mode.js'
// ⚠️ 这几条测试要读一个真实的记忆库目录。
// 别人 clone 下来没有这个目录，所以从环境变量取；没设就跳过（退出码 0）。
const MEM_FROM_ENV = () => process.env.DSH_MEMORY_DIR || ''


const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-format-'))

const SAMPLES = [
  ['bullet 节', `# 测试
<!-- 标签: 测试 -->
- 第一条
- 第二条
- 第三条
`, 'bullet'],

  ['numbered 节', `# 测试
<!-- 标签: 测试 -->
1. 第一条
2. 第二条
3. 第三条
`, 'numbered'],

  ['table 节', `# 测试
<!-- 标签: 测试 -->
| a | b |
| --- | --- |
| 1 | 2 |
| 3 | 4 |
`, 'table'],

  ['空节', `# 测试
<!-- 标签: 测试 -->
`, 'bullet'],

  ['混杂但 bullet 过半', `# 测试
- 一
- 二
- 三
随便一句散话
`, 'bullet'],

  ['表格 + 说明文字', `# 测试
| 症状 | 原因 |
| --- | --- |
| A | B |
| C | D |
一段说明
`, 'table'],
]

console.log('='.repeat(72))
console.log('章节格式探测（import 真实实现）')
console.log('='.repeat(72))

let pass = 0
for (const [name, body, want] of SAMPLES) {
  const lines = body.split('\n')
  const got = detectSectionFormat(lines, 0, lines.length)
  const ok = got === want
  if (ok) pass += 1
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(20)} got=${got.padEnd(9)} want=${want}`)
}

console.log()
console.log(`${pass}/${SAMPLES.length} 通过`)

console.log()
console.log('='.repeat(72))
console.log('真实记忆库各节格式分布（抽样）')
console.log('='.repeat(72))

if (!MEM_FROM_ENV()) {
  console.log('⏭  跳过：没有设置 DSH_MEMORY_DIR（这几条测试要读真实记忆库）')
  process.exit(0)
}


const MEM = MEM_FROM_ENV()
const COUNTS = { bullet: 0, numbered: 0, table: 0 }

for (const f of fs.readdirSync(MEM)) {
  if (!f.endsWith('.md')) continue
  const lines = fs.readFileSync(path.join(MEM, f), 'utf8').split('\n')
  const heads = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) heads.push(i)
  }
  for (let k = 0; k < heads.length; k += 1) {
    const start = heads[k]
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length
    const fmt = detectSectionFormat(lines, start, end)
    COUNTS[fmt] += 1
  }
}

console.log(`  bullet   ${COUNTS.bullet} 节`)
console.log(`  numbered ${COUNTS.numbered} 节`)
console.log(`  table    ${COUNTS.table} 节  ← 这些节会被拒绝自动写入`)

fs.rmSync(TMP, { recursive: true, force: true })
