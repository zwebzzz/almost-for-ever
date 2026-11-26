// Almost For Ever — 记忆的现场索引与精确检索
//
// 核心主张：
//   索引不存盘，每次现场从记忆文件的结构派生。
//   库改名 / 拆库 / 合库 / 删库 —— 索引自动跟上，没有第二份真相可腐烂。
//
// 读 / 写节奏（实测依据见 README）：
//   读：每轮都做，但只注入「命中条目的标题 + 行号」，约 100~150 tok。
//   写：实现了（见 lib/write-mode.js）。

import fs from 'node:fs'
import path from 'node:path'
import { applyWriteMode, noteReadHits } from './lib/write-mode.js'
import { stem, stemForms } from './lib/stem.js'
import { GENERIC_TAGS, PARENT_TAG, QUERY_LEXICON, STATUS_TAGS, queryTags } from './lib/lexicon.js'

export { queryTags }

const DEFAULT_MEMORY_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.dsh',
  'memory',
)

// ── 检索词表 ─────────────────────────────────────────────
// 词表、父标签、泛标签、queryTags 都在 lib/lexicon.js —— 写入侧（appendToMemory
// 补章节标签）要用同一套，留在这里会让 write-mode.js 反向 import 成环。

// 库级标签：查表失败时按文件名前缀兜底（新增 04x / 10b 类文件不必改这里）。
// 不从正文自动抽 —— 正文里什么词都出现过，自动抽会把偶然当本质。
const LIB_TAGS = {
  '00-急救': ['急救'],
  '00-维护规则': ['记忆维护'],
  '01-profile': ['助手笔记'],
  '02-preferences': ['偏好'],
  '03-software': ['软件'],
  '04-projects': ['项目'],
  '05-environment': ['环境', '机器'],
  '06-ai-toolchain': ['AI工具'],
  '07-proxy-network': ['网络'],
  '08-log-forensics': ['取证'],
  '09-windows-cmd': ['命令'],
  '10-windows-cleanup': ['清理'],
  '11-dsh-plugin-dev': ['插件开发', 'DSH'],
}

// 文件名前缀 → 兜底库标签。
// 这样新增 04i-xxx.md 或 10c-xxx.md 时，不写标签也能被归到对的大类。
const LIB_TAG_BY_PREFIX = [
  ['04', ['项目']],
  ['10b', ['清理']],
  ['06', ['AI工具']],
  ['07', ['网络']],
  ['09', ['命令']],
  ['11', ['插件开发', 'DSH']],
]

/**
 * 从文件名 / 文件标题 / 章节标题**动态生成**库级标签。
 *
 * 为什么要有这个：写死的 LIB_TAGS 只对作者这边的 13 个库成立。
 * 别人的库叫「工作日志」「health」「notes」，查表查不到 → 标签维度完全失效，
 * 检索退化成纯字面匹配。实测：换个库名，4 个问题只中 1 个。
 *
 * 动态生成的规则：把这些地方出现的词当作标签，让**用户自己的库名本身**成为线索。
 */
function dynamicLibTags(stem, libTitle, sectionTitles) {
  const tags = new Set()
  // ① 文件名去掉数字前缀
  const bare = stem.replace(/^[0-9]+[a-z]?[-_]/, '').replace(/[-_]/g, ' ')
  for (const t of tokenize(bare)) tags.add(t)
  // ② 文件标题（# x）
  if (libTitle) for (const t of tokenize(libTitle)) tags.add(t)
  // ③ 章节标题能提示这本书在讲什么（只取前 6 个，避免噪音）
  for (const s of (sectionTitles || []).slice(0, 6)) {
    for (const t of tokenize(s)) tags.add(t)
  }
  return [...tags]
}

function libTagsOf(stem, libTitle, sectionTitles) {
  // 作者这边的库 → 用人工标好的高质量标签
  if (LIB_TAGS[stem]) return LIB_TAGS[stem]
  for (const [prefix, tags] of LIB_TAG_BY_PREFIX) {
    if (stem.startsWith(prefix)) return tags
  }
  // 别的库 → 动态生成（保证「换个环境」也能工作）
  return dynamicLibTags(stem, libTitle, sectionTitles)
}

// 查询里的「意图词」
const PROGRESS_INTENT = /做到哪|进度|怎么样了|什么状态|还差|没做完|还活着吗/
const DONE_INTENT = /做完了吗|结了|交付|完成没/

// 泛标签 / 状态标签的定义已移到 lib/lexicon.js（写入侧也要用同一套）。

// 助手自用的工作笔记：不是用户知识的检索目标，降权而非排除。
const LOW_PRIORITY_LIBS = new Set(['01-profile'])

// 中文停用字：只留**纯虚词**。
//
// 教训：原来这张表里塞了「好」「看」「要」「会」「能」「到」「上」这些半实词，
// 于是「偏好」的「好」被判成停用字 → 整个二元组被丢掉 →
// 问「我的偏好是什么」一个 token 都剩不下，什么库都查不到。
// 「实词一个字都不能进这张表」。
const STOP_HAN = new Set('的了是我你他在有和就不都一个也很没这那么怎样吗呢吧啊把被从对为与及其之以而已于')

/**
 * 中文里的「无意义疑问尾缀」：这类词几乎出现在每个提问里，留进 token 集合
 * 只会稀释覆盖率。实测「我的偏好是什么」原样切成 6 个二元组，
 * 其中一个都不剩（全被停用字吃掉）→ 查什么都查不到。
 *
 * 处理：先把这些整词从查询里去掉，再切二元组。
 */
const QUERY_NOISE_HAN = [
  '是什么', '什么', '怎么样', '怎么', '怎样', '如何', '哪些', '哪个', '多少',
  '为什么', '是不是', '能不能', '要不要', '有什么', '一下', '请问', '告诉我',
  '我现在', '我的', '你的', '他的', '我想要', '我想', '我想知道', '看一下', '看下',
]

/**
 * 把中文查询里的疑问词 / 人称代词剔掉。
 * 「我的偏好是什么」→ 「偏好」→ 二元组「偏好」，能对上库名。
 */
function stripQueryNoise(text) {
  let s = String(text || '')
  for (const w of QUERY_NOISE_HAN) s = s.split(w).join(' ')
  return s
}

// ── 文本工具 ─────────────────────────────────────────────

// 英文停用词：这类词在每个句子里都有，留在 token 集合里只会稀释覆盖率。
// 实测：「what are my preferences」切出 5 个 token，其中 3 个是停用词，
// 覆盖率被稀释到 0.2，低于门槛 → 明明库里写着 preferences 也查不到。
const STOP_EN = new Set([
  'what', 'are', 'is', 'was', 'were', 'the', 'and', 'or', 'of', 'to', 'in', 'on',
  'for', 'with', 'my', 'your', 'our', 'his', 'her', 'its', 'their', 'this', 'that',
  'how', 'should', 'could', 'would', 'can', 'do', 'does', 'did', 'be', 'been',
  'i', 'me', 'we', 'you', 'it', 'they', 'them', 'a', 'an', 'at', 'by', 'as',
  'about', 'from', 'into', 'not', 'no', 'yes', 'please', 'tell', 'show', 'give',
])

/**
 * 中文二元组 + ASCII 词（带词干、去停用词）。
 *
 * ASCII 部分同时放原词和词干，这样：
 *   查询 "my preferences" → preferences / prefer
 *   库里 "Prefers concise" → prefers / prefer
 *   → 词干相同，匹配得上
 */
export function tokenize(text) {
  const out = new Set()
  const lower = stripQueryNoise(String(text || '')).toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9_\-./]{2,}/g)) {
    // 英文停用词丢掉 —— 否则「what are my preferences」的覆盖率被稀释到 0.4 以下
    if (STOP_EN.has(m[0]) && !/[0-9_\-./]/.test(m[0])) continue
    for (const form of stemForms(m[0])) {
      if (!STOP_EN.has(form)) out.add(form)
    }
  }
  for (const seg of lower.split(/[^\u4e00-\u9fff]+/)) {
    for (let i = 0; i < seg.length - 1; i += 1) {
      const bg = seg.slice(i, i + 2)
      // 只有不相干的虚词才丢：**两个字都在停用表里**才算噪音。
      // 原来只要有一个字在表里就丢 —— 把「偏好」（「好」在表里）也吃掉了，
      // 结果问「我的偏好是什么」一个 token 都不剩，什么库都查不到。
      if (STOP_HAN.has(bg[0]) && STOP_HAN.has(bg[1])) continue
      out.add(bg)
    }
  }
  return out
}

/**
 * 两个 token 是否算命中。
 *
 * 中文二元组必须精确相等（2 个字没有「前缀」概念，放宽会误伤）。
 * ASCII 词允许**前缀匹配**：英文形态变化（preference / preferences / prefers）
 * 靠词干规则追不全，实测 preferences ↔ prefers 对不上。
 * 判据是「公共前缀占短词的 70% 以上」，比固定字符差更稳。
 */
function tokenMatch(a, b) {
  if (a === b) return true
  if (a.length < 4 || b.length < 4) return false
  // 只有纯 ASCII 才走前缀匹配
  if (!/^[a-z0-9_\-./]+$/.test(a) || !/^[a-z0-9_\-./]+$/.test(b)) return false
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  let n = 0
  while (n < short.length && short[n] === long[n]) n += 1
  return n / short.length >= 0.7
}

/** 两个 token 集合之间命中了几个（含前缀匹配）。 */
function countTokenHits(queryTokens, targetTokens) {
  let hit = 0
  for (const q of queryTokens) {
    if (targetTokens.has(q)) {
      hit += 1
      continue
    }
    for (const t of targetTokens) {
      if (tokenMatch(q, t)) {
        hit += 1
        break
      }
    }
  }
  return hit
}

/**
 * 查询词在正文里真实出现了几次（ASCII 按词边界，中文按子串）。
 *
 * 为什么需要：正文 token 是去重集合，只能回答「有没有提到」，
 * 回答不了「提了几次」——而后者才是同分时最可靠的区分依据。
 */
function countTokenFrequency(text, queryTokens) {
  const lower = String(text || '').toLowerCase()
  let total = 0
  for (const q of queryTokens) {
    if (!q) continue
    const ascii = /^[a-z0-9_\-./]+$/.test(q)
    let from = 0
    while (true) {
      const at = lower.indexOf(q, from)
      if (at < 0) break
      if (ascii) {
        // 词边界：查 github 不该把 git 的每次出现都算进来，反之亦然。
        const before = lower[at - 1]
        const after = lower[at + q.length]
        const cleanBefore = !before || !/[a-z0-9]/.test(before)
        const cleanAfter = !after || !/[a-z0-9]/.test(after)
        if (cleanBefore && cleanAfter) total += 1
      } else {
        total += 1
      }
      from = at + q.length
    }
  }
  return total
}

function overlapRatio(queryTokens, targetTokens) {
  if (!queryTokens.size || !targetTokens.size) return 0
  let hit = 0
  for (const q of queryTokens) {
    if (targetTokens.has(q)) {
      hit += 1
      continue
    }
    for (const t of targetTokens) {
      if (tokenMatch(q, t)) {
        hit += 1
        break
      }
    }
  }
  return hit / queryTokens.size
}

/** 两个 token 集合的并集。 */
function unionTokens(a, b) {
  const out = new Set(a)
  for (const t of b) out.add(t)
  return out
}

/** 从文本里抽标签：先按词表，再向上补父标签。 */
export function tagsOf(text, explicit = []) {
  const lower = String(text || '').toLowerCase()
  const tags = new Set(explicit)
  for (const [word, tag] of Object.entries(QUERY_LEXICON)) {
    if (lower.includes(word)) tags.add(tag)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [child, parent] of Object.entries(PARENT_TAG)) {
      if (tags.has(child) && !tags.has(parent)) {
        tags.add(parent)
        changed = true
      }
    }
  }
  return tags
}

// ── 索引派生 ─────────────────────────────────────────────

const TAG_COMMENT = /<!--\s*(?:标签|tags?)\s*[:：]\s*(.*?)\s*-->/
const META_SECTION = /^(子索引|其他|待处理|维护)/

function stripMd(s) {
  return String(s || '').replace(/[*`_#>]/g, '').trim()
}

/**
 * 扫描记忆目录，派生出「库 → 章节 → 行号」的目录树。
 * 不缓存、不落盘：目录里有什么，索引就是什么。
 */
export function deriveIndex(memoryDir) {
  let files
  try {
    files = fs.readdirSync(memoryDir)
  } catch {
    return []
  }

  const libs = []
  for (const file of files.sort()) {
    if (!file.endsWith('.md')) continue
    let text
    try {
      text = fs.readFileSync(path.join(memoryDir, file), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    const stem = file.slice(0, -3)

    let libTitle = ''
    let libTags = []
    let pinned = []      // 首个 H2 之前的内容
    const sections = []
    let cur = null
    let curEntry = null   // 当前正在累积的 bullet

    const pushEntry = () => {
      if (cur && curEntry) cur.entries.push(curEntry)
      curEntry = null
    }

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const tagHit = TAG_COMMENT.exec(line)
      if (tagHit) {
        const names = tagHit[1].split(/[,，、]/).map((x) => x.trim()).filter(Boolean)
        if (cur) cur.tags.push(...names)
        else libTags.push(...names)
        // 标签注释行不进正文（不算字数），但它确实是这一节的最后一行 ——
        // 行号区间不含它，读文件的 AI 就会漏掉节尾的那一条。
        if (cur) cur.lastLine = i + 1
        continue
      }
      if (line.startsWith('# ') && !libTitle) {
        libTitle = stripMd(line.slice(2))
        continue
      }
      if (line.startsWith('## ')) {
        pushEntry()
        if (cur) sections.push(cur)
        cur = {
          title: stripMd(line.slice(3)),
          line: i + 1,
          lastLine: i + 1,
          body: [],
          tags: [],
          entries: [],
        }
        continue
      }
      // 条目级：行首 `- ` 或 `* ` 开启一条，续行归入上一条
      if (cur && /^\s*[-*] /.test(line)) {
        pushEntry()
        curEntry = {
          head: stripMd(line.replace(/^\s*[-*] /, '')),
          line: i + 1,
          lastLine: i + 1,
          body: [line],
        }
        // ⚠️ 条目行必须同时进 cur.body —— 否则正文兜底维度只看得到非列表行，
        // 且 UI 面板的字符数会严重低估（实测少算 66%）。
        cur.body.push(stripMd(line))
        cur.lastLine = i + 1
        continue
      }
      if (cur) {
        cur.body.push(stripMd(line))
        cur.lastLine = i + 1
        if (curEntry) {
          curEntry.body.push(line)
          curEntry.lastLine = i + 1
        }
      } else {
        pinned.push(stripMd(line))
      }
    }
    pushEntry()
    if (cur) sections.push(cur)

    // 没有 H2 的库：不要退化成「整篇 1 节」。
    // 实测：别人写的 `# 我的笔记` + 几行 `- ` 会被压成 1 节，标题就是「我的笔记」，
    // 问「猫叫什么名字」永远匹配不上。
    // 改成按「条目」切节 —— 每条自成一段，标题取该条开头。
    if (sections.length === 0) {
      const pieces = []
      let curP = null
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i]
        const bullet = /^\s*[-*] /.test(raw)
        const numbered = /^\s*\d+[.、)]\s/.test(raw)
        const h3 = /^#{3,} /.test(raw)
        if (bullet || numbered || h3) {
          if (curP) pieces.push(curP)
          const text = stripMd(
            raw.replace(/^\s*[-*] /, '').replace(/^\s*\d+[.、)]\s/, '').replace(/^#{3,} /, ''),
          )
          curP = {
            title: text.slice(0, 48),
            line: i + 1,
            lastLine: i + 1,
            body: [stripMd(raw)],
            tags: [],
            entries: [],
          }
        } else if (curP) {
          curP.body.push(stripMd(raw))
          curP.lastLine = i + 1
        }
      }
      if (curP) pieces.push(curP)

      if (pieces.length >= 2) {
        sections.push(...pieces)
      } else {
        // 真的只有一两行，就按整篇（标题用文件标题或文件名）
        sections.push({
          title: libTitle || stem,
          line: 1,
          body: pinned.filter(Boolean),
          tags: [],
          entries: [],
        })
      }
    }

    // 文件 H1 的 token —— 每一节都继承它，因为 H1 是「这本书在讲什么」
    const libTitleTokens = tokenize(libTitle)

    libs.push({
      file,
      stem,
      title: libTitle,
      // 库级标签 = 人工表（作者这边的库优先）→ 前缀兜底 → 动态生成（换环境也能用）
      tags: tagsOf('', [
        ...libTagsOf(stem, libTitle, sections.map((s) => s.title)),
        ...libTags,
      ]),
      // 有没有「人写的高质量标签」——决定检索档位，见 search()
      tagsSource:
        LIB_TAGS[stem] || LIB_TAG_BY_PREFIX.some(([p]) => stem.startsWith(p))
          ? 'manual'
          : 'dynamic',
      sections: sections.map((s) => {
        const bodyText = s.body.join(' ')
        const chars = s.body.reduce((n, l) => n + l.length, 0)
        return {
          title: s.title,
          line: s.line,
          // 原始正文：同分排序要回答「这个词到底出现几次」，而 token 集合是去重的。
          bodyRaw: bodyText,
          // 真实末行。以前用「起始行 + 正文行数」推，跳过的标签注释行不算进去，
          // 带标签的节尾就被切掉一行，读文件的范围跟着少一行。
          endLine: s.lastLine || s.line,
          // 真实正文字符数 —— UI 面板据此估算 token（中文约 1.5 字符/token）
          chars,
          meta: META_SECTION.test(s.title),
          // 标题 token 要带上文件 H1 —— H1 是「这本书在讲什么」，
          // 每一节都属于这本书。实测：某个项目库正文靠 H1 的项目名命中，
          // 拆成条目节后 H1 没进任何节标题，同一个查询就查不到了。
          titleTokens: unionTokens(tokenize(s.title), libTitleTokens),
          bodyTokens: tokenize(bodyText),
          // 章节标签只认显式声明。
          // 实测：从标题+正文抽标签噪音极大 —— 02-preferences「沟通风格」
          // 会因为正文提了一句就被贴成「工具/取证/急救/插件开发」。
          // 标签是人为「这条属于哪一类」的判断，机器只是出现过那个词。
          tags: tagsOf('', s.tags),
          // 条目级：命中章节后再精确到条，避免整块读一个 4800 tok 的章节。
          entries: s.entries.map((e) => ({
            head: e.head,
            line: e.line,
            endLine: e.lastLine || e.line,
            tokens: tokenize(e.head),
            bodyTokens: tokenize(e.body.map(stripMd).join(' ')),
          })),
        }
      }),
    })
  }
  return libs
}

// ── 检索 ────────────────────────────────────────────────

// queryTags 在 lib/lexicon.js（写入侧也要用），顶部已 re-export。

/**
 * 多维交叉打分。
 * 维度：① 标签交叉 ② 标题字面 ③ 正文兜底 ④ 状态意图
 * 不要求「必须全中」——任一线索都加分，说错了别的维度兜住。
 */
export function search(libs, query, limit = 3) {
  const qt = queryTags(query)
  const qTok = tokenize(query)
  const wantProgress = PROGRESS_INTENT.test(query)
  const wantDone = DONE_INTENT.test(query)

  const scored = []
  for (const lib of libs) {
    // 助手自用笔记不是用户知识的检索目标，整体降权。
    const libWeight = LOW_PRIORITY_LIBS.has(lib.stem) ? 0.35 : 1

    for (const sec of lib.sections) {
      if (sec.meta) continue
      const why = []
      let topical = 0
      // 具体证据：标题/正文真的命中了几处。库级标签一命中，整本书每一节都同分，
      // 只按分数排序时前几名就退化成「文件里排最前的几节」——所以同分要比这个。
      let evidence = 0

      // 档位：作者的库有人工标签 → 严格；别人的库只有动态标签 → 放宽。
      // 为什么分档：正文兜底原本要「先有主题分」才参与（防止噪音），
      // 但别人的库没有高质量标签，主题分永远是 0 —— 于是正文永远不参与，
      // 检索退化成「只能靠标题撞词」。实测通用命中率只有 42%。
      const strict = lib.tagsSource === 'manual'
      const bodyMinCov = strict ? 0.4 : 0.18
      const bodyWeight = strict ? 2 : 4
      const bodyCanStand = !strict

      // ① 标签交叉。具体标签权重高、泛标签几乎不区分 ——
      //    实测教训：把「项目」「游戏」当 1.5~3 分加，会让带「项目」标签的库
//    压过真正对口的那个库。
      for (const tag of qt) {
        if (!sec.tags.has(tag) && !lib.tags.has(tag)) continue
        let weight = 3
        if (GENERIC_TAGS.has(tag)) weight = 0.5
        else if (STATUS_TAGS.has(tag)) weight = 0     // 状态不参与主题分
        if (weight === 0) continue
        // 库的「主标签」比章节顺带提到的标签更强，也比标题字面更可信 ——
        // 「插件怎么写」实测：11 号库主标签就是「插件开发」，
        // 却输给了 10b 的「插件市场残留」（只是标题里含"插件"二字）。
        if (lib.tags.has(tag)) weight += 4
        topical += weight
        why.push(`${tag}${weight < 3 ? `×${weight.toFixed(1)}` : ''}`)
      }

      // ② 标题字面：最可靠的线索，但查询太短时不可信 ——
      //    只有 1~2 个 token 时，命中一个就是 100%，会把「插件市场残留」也顶上来。
      //
      //    长查询要放宽门槛：中文二元组会把「我电脑电池怎么设置的」切出 6 个，
      //    其中 3 个是跨词噪音（我电 / 脑电 / 置的），真正命中的「电池」只占 1/6。
      //    门槛 0.25 会把这种正确命中直接判死。
      //    → 用「命中 token 的绝对个数」兜底：≥2 个也算强信号，不论覆盖率。
      const titleHitCount = countTokenHits(qTok, sec.titleTokens)
      const titleCov = overlapRatio(qTok, sec.titleTokens)
      const titlePass = titleCov >= 0.25 || (titleHitCount >= 2 && titleCov >= 0.15)
      // 单字强命中：长查询里命中一个罕见汉字也算（「电池」这种词 → 「电池」在标题里）
      const titleSingleHit = titleHitCount >= 1 && titleCov >= 0.15
      if (titlePass || (titleSingleHit && qTok.size >= 4)) {
        const trust = qTok.size <= 2 ? 0.55 : 1
        topical += titleCov * 8 * trust
        evidence += 3
        why.push(`标题${Math.round(titleCov * 100)}%(${titleHitCount}词)`)
      }

      // ③ 正文兜底：严格档只在已有主题分时参与；宽松档允许单独命中。
      const bodyCov = overlapRatio(qTok, sec.bodyTokens)
      if (bodyCov >= bodyMinCov) {
        const freqBonus = Math.min(countTokenFrequency(sec.bodyRaw, qTok), 3)
        if (strict && topical <= 0) {
          // 严格档原本完全不救场。但「查询词整词出现在正文里」本身就是证据：
          // 全库 22 处正文提到 GitHub，只有 2 节带 GitHub 标签或标题含 github，
          // 剩下 20 处正文写满了却召回不到 —— 检索退化成「只认标签」。
          // 放行条件收得很紧：几乎全中 + 查询只有一两个词，避免长句里的零星撞词。
          if (bodyCov >= 0.75 && qTok.size <= 2) {
            topical += bodyCov * 1
            evidence += 1 + freqBonus
            why.push(`正文${Math.round(bodyCov * 100)}%(无标签)`)
          }
        } else {
          topical += bodyCov * bodyWeight
          evidence += 1 + freqBonus
          why.push(`正文${Math.round(bodyCov * 100)}%`)
        }
      }

      // 主题分为 0 的条目直接淘汰 —— 状态意图不能凭空造出候选。
      if (topical <= 0) continue

      let score = topical

      // ④ 状态意图：只对已有主题分的条目做「同分时的排序微调」。
      //    幅度必须远小于主题分，否则「进行中」会把不相干的条目顶上去。
      const bodyText = `${sec.title} ${[...sec.bodyTokens].join('')}`
      const isDone = /结项|已完成|已交付|已归档/.test(bodyText) || sec.tags.has('已结项')
      const isLive = /进行中|未完成|在做|待验证|遗留问题/.test(bodyText) || sec.tags.has('进行中')
      if (wantProgress) {
        if (isLive) {
          score += topical * 0.15
          why.push('进行中×1.15')
        }
        if (isDone) {
          score -= topical * 0.15
          why.push('已结项×0.85')
        }
      }
      if (wantDone && isDone) {
        score += topical * 0.15
        why.push('已结项×1.15')
      }

      score *= libWeight
      if (score > 0) scored.push({ score, evidence, lib, sec, why })
    }
  }

  // 同分时先看「具体证据」多的：否则整库标签命中后，前几名就是文件里排最前的几节。
  scored.sort((a, b) => b.score - a.score || b.evidence - a.evidence)
  return { queryTags: qt, hits: scored.slice(0, limit) }
}

// ── 渲染成给模型看的一小段字 ────────────────────────────

/**
 * 命中章节后，再在章节内定位到「最贴近的那一条」，给出条目级行号。
 * 章节可能 4800 tok，条目中位 88 tok —— 精确到条才真省钱。
 */
export function bestEntry(sec, qTok) {
  if (!sec.entries || sec.entries.length === 0) return null
  let best = null
  for (const e of sec.entries) {
    let s = overlapRatio(qTok, e.tokens) * 10
    if (s === 0) s = overlapRatio(qTok, e.bodyTokens) * 3
    if (!best || s > best.s) best = { s, e }
  }
  // 相似度太低就不硬指，免得把模型带到错的地方
  return best && best.s > 0 ? best.e : null
}

export function renderHits({ queryTags: qt, hits }, qTok = new Set()) {
  if (!hits.length) return ''
  const head = qt.size ? `【记忆命中·${[...qt].join('/')}】` : '【记忆命中】'
  const rows = hits.map((h) => {
    const tag = h.lib.stem.replace(/\.md$/, '')
    const entry = bestEntry(h.sec, qTok)
    // 命中条目时给条目行号（更省钱），否则退回章节行号
    const span = entry ? `${entry.line}-${entry.endLine}` : `${h.sec.line}-${h.sec.endLine}`
    const label = entry ? `${h.sec.title} → ${entry.head.slice(0, 46)}` : h.sec.title
    return `- ${tag}:${span}　${label}`
  })
  return [
    head,
    ...rows,
    '（以上是从记忆库现场派生出的候选。需要细节时用 read 工具读取对应文件的那几行，不要整文件读。）',
  ].join('\n')
}

// ── 插件本体 ─────────────────────────────────────────────

export const name = 'almost-for-ever'

// 只硬依赖 systemPrompt。
// tools / webServer 用 ctx.get 可选获取 —— 这个版本不支持对象形式 inject。
export const inject = ['systemPrompt']

export function apply(ctx, config = {}) {
  const memoryDir = config.memoryDir || DEFAULT_MEMORY_DIR
  const maxHits = Number.isFinite(config.maxHits) ? config.maxHits : 5
  // 每轮注入的硬预算（字符数）。超过就只保留最靠前的几条。
  const budgetChars = Number.isFinite(config.budgetChars) ? config.budgetChars : 1200

  // 每个 agent 最近一次的提问；systemPrompt 组装时按 scope 取。
  const latestQuery = new WeakMap()
  let latestAny = ''

  ctx.effect(() =>
    ctx.on('agent/pre-step', (payload, next) => {
      try {
        const text = extractUserText(payload?.messages)
        if (text) {
          latestAny = text
          const agent = payload?.agent
          if (agent && typeof agent === 'object') latestQuery.set(agent, text)
        }
      } catch {
        // 读不到就当没有 query，静默降级
      }
      return next()
    }),
  )

  const resolveQuery = (assembleContext) => {
    const scope = assembleContext?.scope
    if (scope && typeof scope === 'object') {
      const q = latestQuery.get(scope)
      if (q) return q
    }
    return latestAny
  }

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'almost-for-ever',
      order: 55,
      text: (assembleContext) => {
        try {
          const query = resolveQuery(assembleContext)
          if (!query) return ''
          const libs = deriveIndex(memoryDir)
          if (!libs.length) return ''
          const result = search(libs, query, maxHits)
          const rendered = renderHits(result, tokenize(query))
          if (!rendered) return ''
          // 记一笔命中，给「记忆」标签页看（哪本书被命中了几次）。
          // scope 是 Agent，agent.session 才是 Session —— 换算一次，
          // 与 write-mode 里的 scopeSession() 同一个道理。
          try {
            const scope = assembleContext && assembleContext.scope
            const session =
              scope && typeof scope === 'object' && scope.session ? scope.session : scope
            noteReadHits(session, result.hits, Math.round(rendered.length / 1.5))
          } catch {
            /* 记账失败不影响注入 */
          }
          return rendered.length > budgetChars
            ? `${rendered.slice(0, budgetChars)}\n（已截断）`
            : rendered
        } catch {
          // 记忆检索坏了绝不能影响正常对话
          return ''
        }
      },
    }),
  )

  // 写入模式（候选收集 + 便利贴接口）挂在这个 ctx 上。
  try {
    // deriveIndex 通过参数传入 —— 从 write-mode.js 反向 import index.js 会成环。
    applyWriteMode(ctx, {
      ...config,
      memoryDir,
      deriveIndex,
      debug: true,
      // 结构面板的检索要跟自动注入用**同一套**打分，否则面板上说「最相关」
      // 和真正喂给模型的那条会不一致，用户会以为插件坏了。
      search,
      tokenize,
      bestEntry,
    })
  } catch (e) {
    // 写入模式坏了也不能拖垮只读检索
    try {
      ctx.logger?.warn?.('almost-for-ever: write mode disabled —', e)
    } catch {
      /* noop */
    }
  }
}

/** 从一组 UserMessage 里取出最后一条的文字。 */
function extractUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== 'user') continue
    return contentToText(msg.content)
  }
  return ''
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}
