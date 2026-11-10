// 离线测试 Almost For Ever 的检索逻辑（不装插件，直接跑纯函数）。

import { deriveIndex, search, renderHits, queryTags, tokenize } from '../index.js'
// ⚠️ 这几条测试要读一个真实的记忆库目录。
// 别人 clone 下来没有这个目录，所以从环境变量取；没设就跳过（退出码 0）。
const MEM_FROM_ENV = () => process.env.DSH_MEMORY_DIR || ''


if (!MEM_FROM_ENV()) {
  console.log('⏭  跳过：没有设置 DSH_MEMORY_DIR（这几条测试要读真实记忆库）')
  process.exit(0)
}


const MEMORY_DIR = MEM_FROM_ENV()

const libs = deriveIndex(MEMORY_DIR)
console.log(`派生索引：${libs.length} 个库`)

// 体积统计
const indexLines = libs.map((lib) => {
  const secs = lib.sections.filter((s) => !s.meta)
  return `${lib.stem}｜${lib.title.slice(0, 30)}｜${secs.length} 节`
})
const indexText = indexLines.join('\n')
console.log(`索引文本 ${indexText.length} 字符 ≈ ${Math.round(indexText.length / 1.5)} tok\n`)

console.log('─'.repeat(76))
console.log('库目录（现场派生，不含条目正文）')
console.log('─'.repeat(76))
console.log(indexText)

// 检索测试
const CASES = [
  ['game-a现在什么状态', 'game-a'],
  ['那个卡牌的游戏做到哪了', 'game-a'],
  ['亚克力那个游戏做到哪了', 'game-a'],
  ['造兵的游戏', 'game-b'],
  ['moba 那个', 'game-c'],
  ['鱼塘那个论文', 'study-a'],
  ['梯子挂了', 'Clash'],
  ['模型列表空了', 'provider'],
  ['我想改个 key', 'provider'],
  ['清理硬盘前要注意什么', '回收站'],
  ['记忆库该怎么维护', '维护规则'],
  ['插件怎么写', '插件'],
]

console.log('\n' + '─'.repeat(76))
console.log('检索测试：正确条目是否进前 3')
console.log('─'.repeat(76))

let hit1 = 0
let hit3 = 0
for (const [query, want] of CASES) {
  const r = search(libs, query, 3)
  const titles = r.hits.map((h) => h.sec.title)
  const pos = titles.findIndex((t) => t.includes(want)) + 1
  if (pos === 1) hit1 += 1
  if (pos > 0 && pos <= 3) hit3 += 1
  const mark = pos > 0 && pos <= 3 ? '✓' : '✗'
  console.log(
    `${mark} 『${query}』 标签=${[...r.queryTags].join('/') || '—'}`,
  )
  r.hits.forEach((h, i) => {
    console.log(
      `    ${i + 1}. [${h.score.toFixed(1)}] ${h.lib.stem}:${h.sec.line} ${h.sec.title.slice(0, 40)}`,
    )
  })
  if (!r.hits.length) console.log('    （无命中）')
}

console.log('\n' + '─'.repeat(76))
console.log(`前 1 命中 ${hit1}/${CASES.length}　前 3 命中 ${hit3}/${CASES.length}`)
console.log('─'.repeat(76))

// 渲染体积
console.log('\n注入文本样例与体积：')
for (const [query] of CASES.slice(0, 3)) {
  const rendered = renderHits(search(libs, query, 3), tokenize(query))
  console.log(`\n『${query}』 → ${rendered.length} 字符 ≈ ${Math.round(rendered.length / 1.5)} tok`)
  console.log(rendered)
}

// 结构漂移测试
console.log('\n' + '─'.repeat(76))
console.log('结构漂移：改文件名后索引是否自动跟上')
console.log('─'.repeat(76))
const fakeLibs = libs.map((l) => (l.stem === '06-ai-toolchain' ? { ...l, stem: '06-AI工具与渠道' } : l))
const before = libs.find((l) => l.stem === '06-ai-toolchain')
const after = fakeLibs.find((l) => l.stem === '06-AI工具与渠道')
console.log(`改名前后同一条目：${before ? before.stem : '-'} → ${after ? after.stem : '-'}`)
console.log('（索引里出现的就是新名字，因为它是现场读的）')

const removed = libs.filter((l) => l.stem !== '08-log-forensics')
console.log(`删掉 08 后库数：${libs.length} → ${removed.length}`)
