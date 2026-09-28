// Chrome 拒绝以 "_" 开头的扩展文件（保留名），而 Parcel 会产出 `_empty.<hash>.js`
// 空 bundle 并在其他 chunk 的 bundle 映射里引用它，导致 chrome://extensions 加载失败：
//   Cannot load extension with file or directory name _empty.<hash>.js
// 本脚本在构建后把该文件重命名为 empty.<hash>.js，并同步更新产物内的所有引用。
// 由 npm 生命周期 postbuild/postpackage 自动执行。
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const SKIP_EXT = new Set([".png", ".jpg", ".ico", ".woff", ".woff2", ".ttf"])

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      walk(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

export function fixUnderscoreBundles(root) {
  if (!fs.existsSync(root)) {
    console.warn(`[postbuild-fix] 目录不存在，跳过: ${root}`)
    return []
  }
  const files = walk(root)
  const renames = []

  // 1) 收集以 _ 开头的文件（按文件名，不含路径）
  const bad = []
  for (const f of files) {
    const base = path.basename(f)
    if (base.startsWith("_") && !fs.statSync(f).isDirectory()) {
      bad.push({ full: f, base })
    }
  }
  if (bad.length === 0) return []

  // 2) 更新文本产物中的引用（全名精确替换，避免误伤）
  for (const f of files) {
    if (SKIP_EXT.has(path.extname(f).toLowerCase())) continue
    let text
    try {
      text = fs.readFileSync(f, "utf8")
    } catch {
      continue
    }
    let next = text
    for (const { base } of bad) {
      if (next.includes(base)) next = next.split(base).join(base.slice(1))
    }
    if (next !== text) fs.writeFileSync(f, next, "utf8")
  }

  // 3) 重命名文件本身
  for (const { full, base } of bad) {
    const target = path.join(path.dirname(full), base.slice(1))
    fs.renameSync(full, target)
    renames.push(`${base} -> ${path.basename(target)}`)
  }
  return renames
}

// 直接执行：node scripts/postbuild-fix.mjs [产物目录]
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const roots = process.argv.slice(2)
  const targets =
    roots.length > 0
      ? roots
      : fs
          .readdirSync("build")
          .map((d) => path.join("build", d))
          .filter((d) => fs.existsSync(path.join(d, "manifest.json")))
  let any = false
  for (const t of targets) {
    const renames = fixUnderscoreBundles(t)
    for (const r of renames) {
      any = true
      console.log(`[postbuild-fix] ${t}: ${r}`)
    }
  }
  console.log(any ? "[postbuild-fix] OK" : "[postbuild-fix] 无 _ 前缀文件")
}
