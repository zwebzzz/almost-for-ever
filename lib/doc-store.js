// 结构面板的读写半边：读一个库的全文、按章节切、带版本指纹写回。
//
// 为什么单独一个文件：
//   write-mode.js 管的是「模型提交候选 → 用户确认 → 落盘」，定位靠 match 原文；
//   这里管的是「人直接改文件」，定位靠行号 + 版本指纹。两者的安全约束完全不同，
//   混在一个文件里两边都会读不清，也没法单独测。
//
// 三条硬约束：
//   ① 只认两个位置：memoryDir 下的 .md，和 memoryDir 上一级的 AGENTS.md（中央文档）。
//      别的路径一律拒 —— 这个模块的写权限必须比模型工具更窄。
//   ② 写之前必留快照（stateDir/undo/），否则一次手滑就是永久损失。
//   ③ 版本指纹不匹配就 conflict，**绝不静默覆盖**。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// 中央文档在 URL 里用的固定库名（不是目录里的文件）。
export const CENTRAL_STEM = 'AGENTS'

// 单个库的硬上限。真超过这个体积，面板里渲染也没意义，直接拒。
const MAX_CHARS = 1_200_000

// 每个库最多留几份快照
const SNAPSHOT_KEEP = 20

function hash(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 12)
}

/** 中央文档路径：memoryDir 的上一级 AGENTS.md。 */
export function centralFile(memoryDir) {
  return path.join(path.dirname(path.resolve(memoryDir)), 'AGENTS.md')
}

/**
 * 库名 → 绝对路径。不合法就返回 { ok: false }。
 * 中文文件名也放行（别人的库可能叫「我的笔记.md」），但绝不允许「..」。
 */
export function resolveDoc(memoryDir, stem) {
  const s = String(stem || '').trim()
  if (!s) return { ok: false, error: '缺少库名' }
  if (s === CENTRAL_STEM) {
    return { ok: true, stem: s, file: centralFile(memoryDir), central: true }
  }
  if (s.includes('..') || /[\\/:*?"<>|\n\r]/.test(s)) {
    return { ok: false, error: '库名不合法' }
  }
  const dir = path.resolve(memoryDir)
  const file = path.resolve(dir, `${s}.md`)
  // 解析后必须仍在 memoryDir 里（防止用别名绕出去）
  if (!file.startsWith(dir + path.sep)) return { ok: false, error: '库名不合法' }
  return { ok: true, stem: s, file, central: false }
}

/**
 * 按 `## ` 切节。行号一律 1 起，跟 deriveIndex 的口径一致。
 *
 * 为什么不用 deriveIndex 的 sections：那边为了检索会把行号压成
 * 「起始行 + 正文行数」，跳过的注释行不算，切出来比真实边界短。
 * 面板要改文本，边界差一行就会吞掉下一节的开头 —— 所以这里按原文硬切。
 */
export function splitDoc(content) {
  // 记忆库文件是 CRLF 存的。不抹掉 \r，章节标题、正文逐行比较都会带着隐藏字符，
  // 而且跟客户端 splitDocText 的口径就对不上了。
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n')
  const marks = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) marks.push(i)
  }
  const sections = marks.map((start, i) => {
    const end = i + 1 < marks.length ? marks[i + 1] : lines.length
    const text = lines.slice(start, end).join('\n')
    let entries = 0
    for (let j = start + 1; j < end; j += 1) {
      if (/^\s*[-*] /.test(lines[j])) entries += 1
    }
    return {
      i,
      title: lines[start].slice(3).trim(),
      line: start + 1,
      start,
      end,
      endLine: end,
      tokens: Math.max(1, Math.round(text.length / 1.5)),
      entries,
    }
  })
  return { lines, sections, headEnd: sections.length ? sections[0].start : lines.length }
}

function payload(resolved, content, exists) {
  const { sections } = splitDoc(content)
  return {
    ok: true,
    stem: resolved.stem,
    central: resolved.central,
    exists,
    content,
    version: exists ? hash(content) : '',
    sections,
    tokens: Math.round(content.length / 1.5),
  }
}

/** 读一个库（或中央文档）。文件不存在不报错，返回 exists: false 让界面走空态。 */
export function readDoc(memoryDir, stem) {
  const r = resolveDoc(memoryDir, stem)
  if (!r.ok) return r
  let content
  try {
    content = fs.readFileSync(r.file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return payload(r, '', false)
    return { ok: false, error: String(e && e.message) }
  }
  if (content.length > MAX_CHARS) return { ok: false, error: '这个文件太大，面板不打开' }
  return payload(r, content, true)
}

// ── 快照（写前留底 + 撤销）────────────────────────────────

function snapDir(stateDir) {
  const dir = path.join(stateDir, 'undo')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* noop */
  }
  return dir
}

function snapName(stem, at) {
  return `${String(stem).replace(/[^\w.-]/g, '_')}.${at}.md`
}

function pushSnapshot(stateDir, stem, content) {
  if (!stateDir || !content) return ''
  try {
    const dir = snapDir(stateDir)
    const name = snapName(stem, Date.now())
    fs.writeFileSync(path.join(dir, name), content, 'utf8')
    // 只留最近 N 份：快照是保险，不是归档
    const prefix = `${String(stem).replace(/[^\w.-]/g, '_')}.`
    const mine = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
      .sort()
    for (const old of mine.slice(0, Math.max(0, mine.length - SNAPSHOT_KEEP))) {
      try {
        fs.unlinkSync(path.join(dir, old))
      } catch {
        /* noop */
      }
    }
    return name
  } catch {
    return ''
  }
}

function newestSnapshot(stateDir, stem) {
  try {
    const dir = snapDir(stateDir)
    const prefix = `${String(stem).replace(/[^\w.-]/g, '_')}.`
    const mine = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
      .sort()
    return mine.length ? path.join(dir, mine[mine.length - 1]) : ''
  } catch {
    return ''
  }
}

function atomicWrite(file, content) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.afe-tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 写回。
 *
 * expectedVersion：
 *   · 字符串（可能是 ''）——必须与磁盘现状一致，否则返回 conflict 并把最新内容带回去
 *   · 不传 / undefined —— 跳过校验（只给撤销这种「我知道会覆盖」的内部调用用）
 */
export function writeDoc(memoryDir, stem, content, expectedVersion, opts = {}) {
  const r = resolveDoc(memoryDir, stem)
  if (!r.ok) return r
  if (typeof content !== 'string') return { ok: false, error: '内容为空' }
  if (content.length > MAX_CHARS) return { ok: false, error: '超过体积上限，拒绝写入' }

  let cur = ''
  let exists = false
  try {
    cur = fs.readFileSync(r.file, 'utf8')
    exists = true
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return { ok: false, error: String(e && e.message) }
  }

  const curVersion = exists ? hash(cur) : ''
  if (typeof expectedVersion === 'string' && expectedVersion !== curVersion) {
    return { ok: false, conflict: true, version: curVersion, content: cur, exists }
  }

  const snapshot = pushSnapshot(opts.stateDir, r.stem, cur)
  try {
    atomicWrite(r.file, content)
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
  const out = payload(r, content, true)
  out.snapshot = snapshot
  return out
}

/** 撤销：把最近一份快照写回去。没有快照就说没有，不假装成功。 */
export function undoDoc(memoryDir, stem, expectedVersion, opts = {}) {
  const r = resolveDoc(memoryDir, stem)
  if (!r.ok) return r
  const src = newestSnapshot(opts.stateDir, r.stem)
  if (!src) return { ok: false, error: '没有可撤销的版本' }

  // 撤销同样是「覆盖写」，也要过版本关：期间别处写过就不能一键盖回去。
  let cur = ''
  let exists = false
  try {
    cur = fs.readFileSync(r.file, 'utf8')
    exists = true
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return { ok: false, error: String(e && e.message) }
  }
  const curVersion = exists ? hash(cur) : ''
  if (typeof expectedVersion === 'string' && expectedVersion !== curVersion) {
    return { ok: false, conflict: true, version: curVersion, content: cur, exists }
  }

  let content
  try {
    content = fs.readFileSync(src, 'utf8')
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
  try {
    atomicWrite(r.file, content)
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
  // 用掉就删：撤销一次就够，留着只在下次误点「撤销」时把用户的新改动顶掉
  try {
    fs.unlinkSync(src)
  } catch {
    /* noop */
  }
  return payload(r, content, true)
}

/** 总览卡要的中央文档摘要（不返回全文，避免 /tree 变重）。 */
export function centralSummary(memoryDir) {
  const d = readDoc(memoryDir, CENTRAL_STEM)
  if (!d.ok) return { stem: CENTRAL_STEM, ok: false, error: d.error, exists: false, tokens: 0, sections: [] }
  return {
    ok: true,
    stem: CENTRAL_STEM,
    central: true,
    exists: d.exists,
    tokens: d.tokens,
    sections: d.sections.map((s) => ({ title: s.title, line: s.line, tokens: s.tokens })),
  }
}
