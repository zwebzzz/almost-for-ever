// 测试「改写 / 删除」这条新链路：直接 import 插件真实实现，不复制逻辑。
//
// 这几条全部在临时目录里跑，不需要真实记忆库，也不需要设 DSH_MEMORY_DIR。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveTarget, replaceInMemory, deleteInMemory, appendToMemory } from '../lib/write-mode.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-edit-'))
const LIB = '02-preferences'

const SRC = `# 测试库

## 一、偏好

- 表格类的东西要写完整
- 删除类的东西要留证据
- 最后一条是陪衬

## 二、踩过的坑

1. 第一条坑
2. 第二条坑
3. 第三条坑
4. 第四条坑

## 三、对照表

| 症状 | 处置 |
| --- | --- |
| 卡住 | 重启 |
| 报错 | 看日志 |
`

function writeSrc() {
  fs.writeFileSync(path.join(TMP, `${LIB}.md`), SRC, 'utf8')
}

function readLines() {
  return fs.readFileSync(path.join(TMP, `${LIB}.md`), 'utf8').split('\n')
}

let pass = 0
let total = 0
function check(name, ok, extra) {
  total += 1
  if (ok) pass += 1
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}

console.log('='.repeat(72))
console.log('resolveTarget：定位唯一一行')
console.log('='.repeat(72))
writeSrc()

let r = resolveTarget(TMP, LIB, '删除类的东西要留证据')
check('唯一命中', r.ok && r.line === 6 && r.original.trim() === '- 删除类的东西要留证据', `line=${r.line}`)

r = resolveTarget(TMP, LIB, '这条根本不存在')
check('找不到就拒绝', !r.ok && /找不到/.test(r.reason), r.reason)

r = resolveTarget(TMP, LIB, '条坑')
check('命中多行就拒绝', !r.ok && /命中 4 行/.test(r.reason), r.reason)

r = resolveTarget(TMP, '99-不存在', '随便')
check('文件不存在就拒绝', !r.ok && /不存在/.test(r.reason), r.reason)

console.log()
console.log('='.repeat(72))
console.log('replaceInMemory：改写保持原格式')
console.log('='.repeat(72))

// ① bullet 行改写 —— 前缀沿用 `- `
writeSrc()
let hit = resolveTarget(TMP, LIB, '表格类的东西要写完整')
let res = replaceInMemory(TMP, { stem: LIB, text: '表格类的东西要写完整（列数不能变）', target: { original: hit.original } })
let lines = readLines()
check('bullet 改写成功', res.ok, res.reason)
check('前缀仍是 `- `', lines[4] === '- 表格类的东西要写完整（列数不能变）', lines[4])
check('行数没变', lines.length === SRC.split('\n').length)

// ② 编号行改写 —— 编号不变
writeSrc()
hit = resolveTarget(TMP, LIB, '第二条坑')
res = replaceInMemory(TMP, { stem: LIB, text: '第二条坑（改写过了）', target: { original: hit.original } })
lines = readLines()
check('编号行改写成功', res.ok, res.reason)
check('编号仍是 2', lines.some((l) => l === '2. 第二条坑（改写过了）'), lines.find((l) => l.includes('改写过了')))

// ③ 模型把前缀也写进来 —— 不该变成 `- - xxx`
writeSrc()
hit = resolveTarget(TMP, LIB, '最后一条是陪衬')
res = replaceInMemory(TMP, { stem: LIB, text: '- 最后一条也是陪衬', target: { original: hit.original } })
lines = readLines()
check('前缀重复被剥掉', res.ok && lines.includes('- 最后一条也是陪衬'), lines.find((l) => l.includes('也是陪衬')))

// ④ 表格行：列数对得上才允许
writeSrc()
hit = resolveTarget(TMP, LIB, '| 卡住 | 重启 |')
res = replaceInMemory(TMP, { stem: LIB, text: '| 卡住 | 先重启再看日志 |', target: { original: hit.original } })
lines = readLines()
check('表格行改写成功', res.ok, res.reason)
check('列数保持 2', lines.includes('| 卡住 | 先重启再看日志 |'))

// ⑤ 表格行：列数对不上必须拒绝
writeSrc()
hit = resolveTarget(TMP, LIB, '| 报错 | 看日志 |')
res = replaceInMemory(TMP, { stem: LIB, text: '| 报错 | 看日志 | 还有第三列 |', target: { original: hit.original } })
check('表格列数不对被拒绝', !res.ok && /列/.test(res.reason), res.reason)

// ⑥ 原文已经被别处改过 —— 拒绝，不许写到错的行上
writeSrc()
hit = resolveTarget(TMP, LIB, '第一条坑')
const stolen = { stem: LIB, text: '不该写进去的内容', target: { original: hit.original } }
const file = path.join(TMP, `${LIB}.md`)
fs.writeFileSync(file, SRC.replace('1. 第一条坑', '1. 第一条坑（别人改过）'), 'utf8')
res = replaceInMemory(TMP, stolen)
check('原文变了就拒绝', !res.ok && /已经变了/.test(res.reason), res.reason)
check('拒绝时文件没被写坏', fs.readFileSync(file, 'utf8').includes('1. 第一条坑（别人改过）'))

console.log()
console.log('='.repeat(72))
console.log('deleteInMemory：删除 + 编号顺延')
console.log('='.repeat(72))

// ⑦ 删编号行 —— 后面的编号顺延，不留空号
writeSrc()
hit = resolveTarget(TMP, LIB, '第二条坑')
res = deleteInMemory(TMP, { stem: LIB, target: { original: hit.original } })
lines = readLines()
check('删除成功', res.ok, res.reason)
check('那一行没了', !lines.some((l) => l.includes('第二条坑')))
const nums = lines.filter((l) => /^\d+[.、)]\s/.test(l.trim())).map((l) => Number(/^(\d+)/.exec(l.trim())[1]))
check('编号顺延无空号', JSON.stringify(nums) === JSON.stringify([1, 2, 3]), JSON.stringify(nums))

// ⑧ 删 bullet 行 —— 只少一行，别的都不动
writeSrc()
hit = resolveTarget(TMP, LIB, '删除类的东西要留证据')
res = deleteInMemory(TMP, { stem: LIB, target: { original: hit.original } })
lines = readLines()
check('删除 bullet 成功', res.ok, res.reason)
check('行数少 1', lines.length === SRC.split('\n').length - 1, `${lines.length} vs ${SRC.split('\n').length}`)
check('相邻两条都还在', lines.includes('- 表格类的东西要写完整') && lines.includes('- 最后一条是陪衬'))

// ⑨ 原文对不上 —— 拒绝
writeSrc()
res = deleteInMemory(TMP, { stem: LIB, target: { original: '- 根本没有这一行' } })
check('原文对不上就拒绝', !res.ok && /已经变了/.test(res.reason), res.reason)
check('拒绝时文件没被改', fs.readFileSync(file, 'utf8') === SRC)

console.log()
console.log('='.repeat(72))
console.log('appendToMemory：表格节能不能追加')
console.log('='.repeat(72))

// ⑩ 表格节 + 内容已是同列数的表格行 —— 放行，插在表格最后一行之后
writeSrc()
res = appendToMemory(TMP, { stem: LIB, section: '三、对照表', text: '| 很慢 | 换渠道 |' })
lines = readLines()
check('表格行追加成功', res.ok && res.format === 'table', res.reason)
check('插在表格末尾', lines[lines.indexOf('| 报错 | 看日志 |') + 1] === '| 很慢 | 换渠道 |')
check('表格后面的东西没被切断', lines.filter((l) => l.trim().startsWith('|')).length === 5, `${lines.filter((l) => l.trim().startsWith('|')).length} 行`)

// ⑪ 表格节 + 内容不是表格行 —— 拒绝，并说清该写成什么样
writeSrc()
res = appendToMemory(TMP, { stem: LIB, section: '三、对照表', text: '很慢就换渠道' })
check('非表格行被拒绝', !res.ok && /一行表格/.test(res.reason), res.reason)
check('拒绝时文件没被改', fs.readFileSync(file, 'utf8') === SRC)

// ⑫ 表格节 + 列数不对 —— 拒绝，报出两边各几列
writeSrc()
res = appendToMemory(TMP, { stem: LIB, section: '三、对照表', text: '| 很慢 | 换渠道 | 备注 |' })
check('列数不对被拒绝', !res.ok && /2 列/.test(res.reason) && /3 列/.test(res.reason), res.reason)
check('列数不对时文件没被改', fs.readFileSync(file, 'utf8') === SRC)

// ⑬ 表格节 + 只写了表头分隔行 —— 拒绝（那不是数据）
writeSrc()
res = appendToMemory(TMP, { stem: LIB, section: '三、对照表', text: '| --- | --- |' })
check('分隔行被拒绝', !res.ok && /分隔行/.test(res.reason), res.reason)

// ⑭ bullet 节不受影响 —— 仍然加 `- `
writeSrc()
res = appendToMemory(TMP, { stem: LIB, section: '一、偏好', text: '新的一条偏好' })
lines = readLines()
check('bullet 节照旧追加', res.ok && res.format === 'bullet', res.reason)
check('bullet 前缀加对了', lines.includes('- 新的一条偏好'))

console.log()
console.log('='.repeat(72))
console.log('行尾：文件是 CRLF 就别插 LF 进去')
console.log('='.repeat(72))

// ⑮ 表格行追加到 CRLF 文件 —— 新行也要 CRLF
const CRLF_LIB = '03-software'
const CRLF = SRC.replace(/\n/g, '\r\n')
fs.writeFileSync(path.join(TMP, `${CRLF_LIB}.md`), CRLF, 'utf8')
res = appendToMemory(TMP, { stem: CRLF_LIB, section: '三、对照表', text: '| 很慢 | 换渠道 |' })
let crlf = fs.readFileSync(path.join(TMP, `${CRLF_LIB}.md`), 'utf8').split('\n')
check('CRLF 文件追加成功', res.ok, res.reason)
check('新行也是 CRLF', crlf.some((l) => l === '| 很慢 | 换渠道 |\r'), JSON.stringify(crlf.find((l) => l.includes('很慢'))))
check('没有混进 LF 行', crlf.filter((l) => l !== '' && !l.endsWith('\r')).length === 0, `${crlf.filter((l) => l !== '' && !l.endsWith('\r')).length} 行是 LF`)

// ⑯ 改写 CRLF 文件的一行 —— 改写后仍是 CRLF
fs.writeFileSync(path.join(TMP, `${CRLF_LIB}.md`), CRLF, 'utf8')
const crlfHit = resolveTarget(TMP, CRLF_LIB, '| 卡住 | 重启 |')
res = replaceInMemory(TMP, { stem: CRLF_LIB, text: '| 卡住 | 先重启再看日志 |', target: { original: crlfHit.original } })
crlf = fs.readFileSync(path.join(TMP, `${CRLF_LIB}.md`), 'utf8').split('\n')
check('CRLF 文件改写成功', res.ok, res.reason)
check('改写后仍是 CRLF', crlf.includes('| 卡住 | 先重启再看日志 |\r'), JSON.stringify(crlf.find((l) => l.includes('先重启'))))

console.log()
console.log('='.repeat(72))
console.log(`${pass}/${total} 通过`)
console.log('='.repeat(72))

fs.rmSync(TMP, { recursive: true, force: true })
process.exit(pass === total ? 0 : 1)
