// 起手模板：空记忆目录时一键生成一套骨架。
//
// 两种规模：
//   minimal  —— 三本（偏好 / 项目 / 环境），小白第一次打开不会被空表格吓到
//   full     —— 八本，覆盖常见需求
//   en       —— 英文版三本（别人用英文干活时）
//
// 原则：
//   ① **不覆盖任何已有文件** —— 用户已经写过的东西，一个字都不动
//   ② 每本只放「骨架 + 一行示例」，不塞大段说明
//   ③ 每本自带 `<!-- 标签: ... -->`，检索立刻可用

const PRESETS = {
  minimal: [
    {
      file: '01-偏好.md',
      title: '偏好',
      tags: ['偏好'],
      sections: [
        [
          '沟通方式',
          ['喜欢什么样的回答：简洁直接 / 详细铺开 / 先结论后依据', '不要什么样的：冗长铺垫 / 主动加戏'],
        ],
        ['边界', ['动手删除或改配置前先问我']],
      ],
    },
    {
      file: '02-项目.md',
      title: '项目',
      tags: ['项目'],
      sections: [
        ['（项目名）', ['是什么：一句话说明', '做到哪了：当前进度', '关键约定：技术栈 / 交付形态']],
      ],
    },
    {
      file: '03-环境.md',
      title: '环境',
      tags: ['环境'],
      sections: [
        ['机器', ['操作系统：Windows', '主要工作目录：', '磁盘：有哪些盘、哪个放什么']],
      ],
    },
  ],

  full: [
    {
      file: '01-偏好.md',
      title: '偏好',
      tags: ['偏好'],
      sections: [
        ['沟通方式', ['喜欢什么样的回答：简洁直接 / 详细铺开 / 先结论后依据']],
        ['边界', ['动手删除或改配置前先问我']],
      ],
    },
    {
      file: '02-项目.md',
      title: '项目',
      tags: ['项目'],
      sections: [
        ['（项目名）', ['是什么：一句话说明', '做到哪了：当前进度', '关键约定：技术栈 / 交付形态']],
      ],
    },
    {
      file: '03-环境.md',
      title: '环境',
      tags: ['环境'],
      sections: [['机器', ['操作系统：Windows', '主要工作目录：', '磁盘：有哪些盘、哪个放什么']]],
    },
    {
      file: '04-软件.md',
      title: '软件',
      tags: ['软件'],
      sections: [['常用软件', ['（软件名）：装在哪']]],
    },
    {
      file: '05-网络.md',
      title: '网络',
      tags: ['网络'],
      sections: [['代理', ['（代理工具）：怎么开']]],
    },
    {
      file: '06-命令.md',
      title: '命令',
      tags: ['命令'],
      sections: [['执行约定', ['用什么语言跑脚本', '哪些命令不能用']]],
    },
    {
      file: '07-清理.md',
      title: '清理',
      tags: ['清理'],
      sections: [['永远别删', ['（清单）']]],
    },
    {
      file: '08-排障.md',
      title: '排障',
      tags: ['排障'],
      sections: [['常见故障', ['（症状）→（原因）→（怎么修）']]],
    },
  ],

  en: [
    {
      file: '01-preferences.md',
      title: 'Preferences',
      tags: ['preferences'],
      sections: [
        ['Communication', ['Prefers concise, direct answers', 'Do not make decisions on my behalf']],
        ['Boundaries', ['Ask before deleting files or changing config']],
      ],
    },
    {
      file: '02-projects.md',
      title: 'Projects',
      tags: ['projects'],
      sections: [['(project name)', ['What it is: one line', 'Status: current progress']]],
    },
    {
      file: '03-environment.md',
      title: 'Environment',
      tags: ['environment'],
      sections: [['Machine', ['OS: Windows', 'Main working directory:']]],
    },
  ],
}

/** 生成某个 preset 的所有文件内容（纯数据，不碰磁盘）。 */
export function buildPreset(preset) {
  const defs = PRESETS[preset]
  if (!defs) return null
  return defs.map((d) => {
    const lines = [`# ${d.title}`, `<!-- 标签: ${d.tags.join(', ')} -->`, '']
    for (const [section, items] of d.sections) {
      lines.push(`## ${section}`)
      lines.push('')
      for (const item of items) lines.push(`- ${item}`)
      lines.push('')
    }
    return { file: d.file, content: lines.join('\n').replace(/\n\n\n/g, '\n\n') }
  })
}

export const PRESET_NAMES = Object.keys(PRESETS)
