// 清单自检：包名 / 客户端模块 id / patch 行名三处必须一致。
//
// 为什么要有这个：改包名时漏改其中任意一处，
// 表现是「插件装了、后端接口在跑，但界面上什么都不出现」，
// 而且控制台没有明显报错 —— 只能靠人回忆「刚才是不是改了名」。

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.dirname(import.meta.dirname)
let fail = 0

function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  console.log(`      ${JSON.stringify(actual)}${ok ? '' : `  ← 期望 ${JSON.stringify(expected)}`}`)
  if (!ok) fail += 1
}

console.log('='.repeat(66))
console.log('清单一致性')
console.log('='.repeat(66))

// 1) package.json
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const name = pkg.name
console.log(`\n包名: ${name}`)

// 2) client.js 的模块 id
const client = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
const m = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
check('client.js 的模块 id == package.json name', m ? m[1] : '（未找到）', name)

// 3) cordis.patch.yml 的行名
const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
const rows = [...patch.matchAll(/\n\s+name:\s*'?([^'\n]+)'?/g)].map((x) => x[1].trim())
check('cordis.patch.yml 的行 name == 包名', rows[0] || '（未找到）', name)

// 4) 文件清单：package.json 的 files 里提到的都在
console.log('\nfiles 清单:')
for (const f of pkg.files || []) {
  if (f.includes('*')) {
    // 通配型：看目录在不在
    const dir = path.join(ROOT, path.dirname(f))
    const ok = fs.existsSync(dir)
    console.log(`  ${ok ? '✓' : '✗'} ${f}  （目录 ${ok ? '在' : '不在'}）`)
    if (!ok) fail += 1
    continue
  }
  const full = path.join(ROOT, f)
  const ok = fs.existsSync(full)
  console.log(`  ${ok ? '✓' : '✗'} ${f}`)
  if (!ok) fail += 1
}

// 5) exports 指向的文件都在
console.log('\nexports 指向:')
for (const [k, v] of Object.entries(pkg.exports || {})) {
  if (typeof v !== 'string' || v.includes('*')) continue
  const ok = fs.existsSync(path.join(ROOT, v))
  console.log(`  ${ok ? '✓' : '✗'} ${k} → ${v}`)
  if (!ok) fail += 1
}

console.log('\n' + '='.repeat(66))
console.log(fail === 0 ? '全部一致 ✅' : `${fail} 处不一致 ❌`)
console.log('='.repeat(66))

process.exit(fail === 0 ? 0 : 1)
