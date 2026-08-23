// build.mjs — 扫描各课 README.md 与 code.ts，生成 docs/lessons.json。
// GitHub Pages 只做静态托管、不跑构建，因此内容必须预先嵌入并提交。
// 课程内容改动后，重新运行 `node docs/build.mjs` 并提交更新后的 lessons.json。

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const docsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(docsDir, "..")

// 课程目录形如 L01_agent_loop、L10_self_modification
const lessonDirs = readdirSync(repoRoot)
  .filter((name) => /^L\d+_/.test(name) && statSync(join(repoRoot, name)).isDirectory())
  .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))

const firstLine = (s) => (s.split("\n")[0] || "").replace(/^#\s*/, "").trim()

const lessons = lessonDirs.map((dir) => {
  const readme = readFileSync(join(repoRoot, dir, "README.md"), "utf8")
  const code = readFileSync(join(repoRoot, dir, "code.ts"), "utf8")
  // 英文 README 可选：存在则一并嵌入，否则前端回落到 TODO 占位
  const enPath = join(repoRoot, dir, "README.en.md")
  const readme_en = existsSync(enPath) ? readFileSync(enPath, "utf8") : ""
  const num = parseInt(dir.slice(1)) // "L05_..." -> 5
  return { dir, num, title: firstLine(readme), title_en: readme_en ? firstLine(readme_en) : "", readme, readme_en, code }
})

writeFileSync(join(docsDir, "lessons.json"), JSON.stringify(lessons, null, 0))
const enCount = lessons.filter((l) => l.readme_en).length
console.log(`已生成 lessons.json：${lessons.length} 课（含英文 README ${enCount} 课）`)
