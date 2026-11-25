// 检索词表：查询词 → 标签。
//
// 为什么单独一个模块：读取侧（index.js 的 search）和写入侧
// （write-mode.js 的 appendToMemory）必须用同一套词表 ——
// 读取侧靠它把用户的提问变成标签，写入侧靠它把新条目自动补成本节标签。
// 放在 index.js 里会让 write-mode.js 反向 import 成环（见 index.js:771 的注释）。

// 只收用户真的会说的词，不做同义猜测。
export const QUERY_LEXICON = {
  卡牌: '卡牌', 打牌: '卡牌', 牌组: '卡牌', 做牌: '卡牌',
  回合: '回合制',
  造兵: 'RTS', 红警: 'RTS', 实时战略: 'RTS',
  moba: 'MOBA', dota: 'MOBA', lol: 'MOBA', 峡谷: 'MOBA',
  遥感: '遥感', 标注: '遥感', 鱼塘: '遥感', 水产: '遥感',
  论文: '论文', 综述: '论文', 学术: '学术',
  游戏: '游戏', 做游戏: '游戏',
  项目: '项目', 在做的: '项目',
  聊天: '聊天', 写作: '聊天',
  工具: '工具',
  梯子: '代理', 代理: '代理',
  上不了网: '网络', 网络: '网络',
  渠道: '渠道', key: '渠道', 换个key: '渠道', 换key: '渠道',
  模型: '模型',
  记忆: '记忆维护', 记忆库: '记忆维护', 维护记忆: '记忆维护',
  记住: '记忆维护', 记一下: '记忆维护', 记下来: '记忆维护', 记着: '记忆维护',
  清理: '清理', 卸载: '清理', 删: '清理',
  命令: '命令', 脚本: '命令',
  日志: '取证', 取证: '取证',
  崩: '急救', 报错: '急救', 打不开: '急救', 坏了: '急救', 起不来: '急救',
  插件: '插件开发',
  // 软件名：问到具体软件装在哪，几乎都是查 03-software
  软件名: '软件', sublime: '软件', matlab: '软件', arcgis: '软件',
  装在: '软件', 装哪: '软件', 安装位置: '软件',
  // git 身份与操作规范在 02-preferences
  git: '偏好', 提交: '偏好', 邮箱: '偏好',
  // GitHub 账号 / 凭据 / 推送 / 建仓在 06-ai-toolchain「子智能体插件与执行环境」
  github: 'GitHub', 推送: 'GitHub', 仓库: 'GitHub', 建仓: 'GitHub',
}

// 父标签（子 → 父）。显式声明，不靠猜。
export const PARENT_TAG = {
  卡牌: '游戏', RTS: '游戏', MOBA: '游戏', 回合制: '游戏',
  游戏: '项目', 学术: '项目', 工具: '项目',
  渠道: 'AI工具', 模型: 'AI工具', 路由: 'AI工具', 子代理: 'AI工具',
  代理: '网络',
}

// 泛标签（父类）：命中只证明「大类对」，不该压过具体标签。
export const GENERIC_TAGS = new Set(['项目', '游戏', '工具', '学术', 'AI工具', '网络'])

// 状态标签：只作意图微调，不参与主要排序。
export const STATUS_TAGS = new Set(['进行中', '已结项', '搁置'])

/** 从一句话里抽标签，并补父标签。 */
export function queryTags(query) {
  // 长词优先，命中过的片段先挖掉再匹配短词。
  // 为什么：词表是子串匹配，"github" 里含 "git" —— 不挖掉就会把 GitHub 误标成「偏好」，
  // 而「偏好」是 02-preferences 的库级标签（+4 分），会把真正对口的 06 号库彻底压死。
  let rest = String(query || '').toLowerCase()
  const tags = new Set()
  for (const word of Object.keys(QUERY_LEXICON).sort((a, b) => b.length - a.length)) {
    if (!rest.includes(word)) continue
    tags.add(QUERY_LEXICON[word])
    rest = rest.split(word).join('\u0000')
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
