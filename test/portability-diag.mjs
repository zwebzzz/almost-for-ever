// 深挖：为什么 C/D/E 三个场景检索不到？逐维度拆开看。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveIndex, search, tokenize, queryTags } from '../index.js'

function build(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-diag-'))
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c, 'utf8')
  return dir
}

const CASES = {
  'C 无章节': {
    'notes.md': `# 我的笔记
- 喜欢喝美式
- 猫叫咪咪
- 周五要交报告
`,
  },
  'D 英文': {
    'preferences.md': `# Preferences
<!-- 标签: preferences -->

## Communication
- Prefers concise answers
- No emoji
`,
  },
  'E 中文异库名': {
    '生活.md': `# 生活
## 健康
- 每天走 8000 步
`,
  },
}

console.log('='.repeat(76))
console.log('为什么检索不到：逐维度拆解')
console.log('='.repeat(76))

for (const [name, files] of Object.entries(CASES)) {
  const dir = build(files)
  const libs = deriveIndex(dir)
  console.log()
  console.log('【' + name + '】')

  const q = name.startsWith('D') ? 'what are my preferences' : '我的偏好是什么'
  const qt = queryTags(q)
  const qTok = tokenize(q)
  console.log(`  查询: ${q}`)
  console.log(`  识别出的标签: [${[...qt].join(',') || '（无）'}]`)
  console.log(`  二元组: [${[...qTok].slice(0, 8).join(',')}]`)

  for (const lib of libs) {
    console.log(`  库 ${lib.stem}: 标签=[${[...lib.tags].join(',') || '（空）'}]`)
    for (const sec of lib.sections) {
      const titleHit = [...qTok].filter((t) => sec.titleTokens.has(t))
      const bodyHit = [...qTok].filter((t) => sec.bodyTokens.has(t))
      console.log(`    节「${sec.title.slice(0, 26)}」标题命中=[${titleHit.join(',') || '无'}] 正文命中=[${bodyHit.join(',') || '无'}]`)
    }
  }

  const r = search(libs, q, 2)
  console.log(`  → 结果: ${r.hits.length ? r.hits[0].lib.stem : '无命中'}`)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log()
console.log('='.repeat(76))
console.log('结论')
console.log('='.repeat(76))
console.log('  ① 只有「标签」这一层能跨语言/跨命名生效，但它靠人的库名匹配 —— 别人的库名不在表里')
console.log('  ② 中文二元组检索对中文有效，对英文/其他语言完全无效')
console.log('  ③ 没有章节的文件被当成 1 节，但标题是文件名，字面命中率很低')
