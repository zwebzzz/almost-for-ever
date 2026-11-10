import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 库的「白话名」—— 给用户在下拉 / 结构面板里看，不用认文件名。
//
// 分三层：
//   `LIB_LABELS`  下拉可选的目标（用户点「记住」时挑）—— 只放**通用概念名**
//   `EXTRA_LABELS` 只给结构面板用（助手笔记这类不适合当下拉目标的）
//   `LOCAL_LABELS` 你自己的库白话名，从 `labels.local.json` 读（不进仓库）
//
// 为什么通用名和私有名要分开：`02-preferences` / `10-windows-cleanup` 这种是
// 「一类东西」，谁都能用；`04b-某个具体项目` 是某个人的私有项目，写死在代码里
// 就等于把别人的项目名当默认值发出去。私有的放进本地 JSON，仓库里只有通用那层。

export const LIB_LABELS = [
  { stem: '02-preferences', label: '偏好和规矩', hint: '沟通方式 / 边界 / 别这么干' },
  { stem: '06-ai-toolchain', label: 'AI 工具和渠道', hint: 'DSH / 模型 / key / Codex' },
  { stem: '04-projects', label: '项目进度', hint: '游戏 / 论文 / 做到哪了' },
  { stem: '10-windows-cleanup', label: '清理和卸载', hint: '删东西 / 残留 / 回收站' },
  { stem: '07-proxy-network', label: '网络和代理', hint: '梯子 / 连不上 / 证书' },
  { stem: '05-environment', label: '机器和环境', hint: '磁盘 / 路径 / 硬件 / 技能' },
  { stem: '09-windows-cmd', label: '怎么写命令和脚本', hint: 'Python 通道 / 白名单' },
  { stem: '11-dsh-plugin-dev', label: '做插件的经验', hint: '座位 / 构建 / 崩溃' },
  { stem: '03-software', label: '软件装在哪', hint: '安装位置表' },
  { stem: '08-log-forensics', label: '查日志取证', hint: '关机还是睡眠 / 跑过什么' },
  { stem: '00-急救', label: '出事了怎么办', hint: '崩 / 打不开 / 回滚' },
]

/** 只给结构面板看的白话名（不出现在「写到哪」下拉里）。 */
export const EXTRA_LABELS = [
  { stem: '00-维护规则', label: '记忆维护规则' },
  { stem: '01-profile', label: '助手的工作笔记' },
  { stem: '10b-uninstall-driver', label: '内核与网卡驱动' },
  { stem: '10b-uninstall-msi', label: 'MSI 产品' },
  { stem: '10b-uninstall-peruser', label: '用户级应用' },
  { stem: '10b-uninstall-pnpm', label: 'DSH profile 包' },
  { stem: '10b-uninstall-market', label: '插件市场残留' },
  { stem: '10b-uninstall-sessioncache', label: '会话缓存里的 key' },
]

/**
 * 读 `labels.local.json` —— 本机自己的库白话名。
 *
 * 两种写法都认：
 *   { "04b-xxx": "某个项目的白话名" }                        ← 简写
 *   { "04b-xxx": { "label": "…", "hint": "…" } }             ← 带提示
 *
 * 文件不存在 / 格式坏了 → 返回 []，绝不让插件起不来。
 */
function readLocalLabels() {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../labels.local.json', import.meta.url)), 'utf8')
    const data = JSON.parse(raw)
    const out = []
    for (const [stem, v] of Object.entries(data || {})) {
      if (!stem) continue
      if (typeof v === 'string') {
        if (v.trim()) out.push({ stem, label: v, hint: '' })
        continue
      }
      if (v && typeof v.label === 'string' && v.label.trim()) {
        out.push({ stem, label: v.label, hint: String(v.hint || '') })
      }
    }
    return out
  } catch {
    return []
  }
}

const LOCAL_LABELS = readLocalLabels()

export const LABEL_BY_STEM = Object.fromEntries(
  [...LIB_LABELS, ...EXTRA_LABELS, ...LOCAL_LABELS].map((x) => [
    x.stem,
    String(x.label).replace(/^　└ /, ''),
  ]),
)

/**
 * 把库名翻成白话；找不到就给一个**可读的兜底**。
 *
 * 为什么兜底不是原样返回：别人的库叫 `notes` / `health` / `工作日志`，
 * 结构面板里直接显示文件名对人类不友好（`10b-uninstall-market` 那种更糟）。
 * 兜底规则：去掉数字前缀、把 `-`/`_` 换成空格、首字母大写。
 */
export function labelOf(stem) {
  const hit = LABEL_BY_STEM[stem]
  if (hit) return hit
  const bare = String(stem || '')
    .replace(/^[0-9]+[a-z]?[-_]/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  if (!bare) return String(stem || '')
  // 纯 ASCII 首字母大写，中文原样
  return /^[a-z]/.test(bare) ? bare[0].toUpperCase() + bare.slice(1) : bare
}
