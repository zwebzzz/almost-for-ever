// doc-store 的离线测试：全部在临时目录里跑，绝不碰真实记忆库。
//
// 为什么这个要单独测：面板的「改一节 / 加章节 / 删条目」最后都落到
// writeDoc 这一个函数上。它写错一次，就是用户的记忆库被切掉半节。
// 这里把三件最要命的事钉住：版本指纹、快照撤销、边界不越界。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CENTRAL_STEM,
  centralSummary,
  readDoc,
  resolveDoc,
  splitDoc,
  undoDoc,
  writeDoc,
} from '../lib/doc-store.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) {
    pass += 1
    console.log(`✓ ${name}`)
  } else {
    fail += 1
    console.log(`✗ ${name}${extra === undefined ? '' : '  → ' + JSON.stringify(extra)}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afe-doc-'))
const memory = path.join(tmp, 'memory')
const state = path.join(tmp, 'state')
fs.mkdirSync(memory, { recursive: true })

const original = [
  '# 测试库',
  '',
  '<!-- 标签: 测试 -->',
  '',
  '## 一、开头',
  '',
  '- 条目一',
  '- 条目二',
  '',
  '## 二、中间',
  '',
  '内容二',
  '',
  '## 三、结尾',
  '',
  '- 末条',
  '',
].join('\n')
fs.writeFileSync(path.join(memory, '00-测试.md'), original, 'utf8')

// ── 读 ──────────────────────────────────────────────────
const d1 = readDoc(memory, '00-测试')
ok(d1.ok === true && d1.exists === true, '能读到一个库')
ok(d1.sections.length === 3, '按 ## 切出 3 节', d1.sections.map((s) => s.title))
ok(d1.version.length === 12, '版本指纹 12 位', d1.version)
ok(
  d1.sections[0].line === 5 && d1.sections[2].line === 14,
  '行号是原文真实行（1 起）',
  d1.sections.map((s) => s.line),
)
ok(d1.sections[0].entries === 2, '数得出一条一条的条目', d1.sections[0].entries)

// ── 版本指纹 ────────────────────────────────────────────
const stale = writeDoc(memory, '00-测试', original + '\n后加的', 'deadbeef0000', { stateDir: state })
ok(stale.ok === false && stale.conflict === true, '版本对不上就 conflict，不硬写')
ok(stale.content === original, 'conflict 把磁盘上的最新内容带回去')

const edited = original.replace('内容二', '内容二（改过）')
const w = writeDoc(memory, '00-测试', edited, d1.version, { stateDir: state })
ok(w.ok === true && w.version !== d1.version, '版本对得上才写入')
ok(fs.readFileSync(path.join(memory, '00-测试.md'), 'utf8') === edited, '磁盘上真的换了')
ok(Boolean(w.snapshot), '写前留了快照')

// ── 撤销 ────────────────────────────────────────────────
// 撤销也要过版本关：先拿一个过期指纹，应被挡下来
const staleUndo = undoDoc(memory, '00-测试', 'deadbeef0000', { stateDir: state })
ok(staleUndo.ok === false && staleUndo.conflict === true, '撤销时版本对不上也要 conflict')
const u = undoDoc(memory, '00-测试', w.version, { stateDir: state })
ok(u.ok === true && u.content === original, '撤销回到原文')
ok(fs.readFileSync(path.join(memory, '00-测试.md'), 'utf8') === original, '磁盘也回去了')
const u2 = undoDoc(memory, '00-测试', undefined, { stateDir: state })
ok(u2.ok === false, '没有快照就说没有，不假装成功')

// ── 边界 ────────────────────────────────────────────────
ok(readDoc(memory, '../evil').ok === false, '拒绝 .. 越界')
ok(readDoc(memory, 'a/b').ok === false, '拒绝带斜杠的名字')
ok(resolveDoc(memory, '').ok === false, '拒绝空名字')

// ── 不存在的文件 / 新建 ─────────────────────────────────
const ghost = readDoc(memory, '99-不存在')
ok(ghost.ok === true && ghost.exists === false && ghost.version === '', '库不存在时返回 exists:false')
const created = writeDoc(memory, '99-不存在', '# 新建\n\n', '', { stateDir: state })
ok(created.ok === true && fs.existsSync(path.join(memory, '99-不存在.md')), '空版本可以新建文件')

// ── 中央文档 ────────────────────────────────────────────
ok(centralSummary(memory).exists === false, '缺中央文档时摘要不报错')
fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# 中央\n\n## 一节\n\n- x\n', 'utf8')
const cd = readDoc(memory, CENTRAL_STEM)
ok(cd.ok === true && cd.central === true && cd.exists === true, '能读到上一级的 AGENTS.md')
const cs = centralSummary(memory)
ok(cs.exists === true && cs.sections.length === 1, '中央文档摘要正确')

// ── 切节口径 ────────────────────────────────────────────
const sp = splitDoc(original)
ok(sp.headEnd === 4, '第一个 ## 之前是头部', sp.headEnd)
ok(
  sp.lines.slice(0, sp.sections[0].start).join('\n').trim() === '# 测试库\n\n<!-- 标签: 测试 -->',
  '头部内容不含章节标题',
)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
