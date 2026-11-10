// 英文词干化：把 prefers / preferences / preferred 归到同一词根。
// 只做最常见、最安全的几条规则 —— 不引第三方 NLP 库（发布出去的包不该有重依赖）。

const IGNORE = new Set(['analysis', 'series', 'species', 'news', 'physics', 'politics'])

/**
 * 极简 stemming。规则顺序很重要：
 *   -ies → -y（studies → study）
 *   -ing / -ed / -es 去掉后仍有 ≥3 字母才真去
 *   -s 只去单个 s（且不是 ss / us / is）
 */
export function stem(en) {
  let w = String(en || '').toLowerCase()
  if (w.length <= 3) return w
  if (IGNORE.has(w)) return w

  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'
  if (w.endsWith('ing') && w.length > 5) {
    const base = w.slice(0, -3)
    // running → run（双写辅音）
    return /([b-df-hj-np-tv-z])\1$/.test(base) ? base.slice(0, -1) : base
  }
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2)
  if (w.endsWith('es') && w.length > 4) {
    // watches → watch（去 es），但 votes 只去 s
    const noEs = w.slice(0, -2)
    if (/(?:sh|ch|ss|x|z)$/.test(noEs)) return noEs
    return w.slice(0, -1)
  }
  if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    return w.slice(0, -1)
  }
  return w
}

/** 一个字符串的所有词根形式（原形 + 词根）。 */
export function stemForms(word) {
  const w = String(word || '').toLowerCase()
  const s = stem(w)
  return s === w ? [w] : [w, s]
}
