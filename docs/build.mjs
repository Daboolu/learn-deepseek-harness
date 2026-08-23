// build.mjs — 扫描各课 README.md 与 code.ts，生成 docs/lessons.json。
// GitHub Pages 只做静态托管、不跑构建，因此内容必须预先嵌入并提交。
// 课程内容改动后，重新运行 `node docs/build.mjs` 并提交更新后的 lessons.json。

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const docsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(docsDir, "..")

// 课程分两大轨道，各是仓库根下的一个目录；每课目录形如 L01_agent_loop、L10_self_modification
const SECTIONS = ["basics", "advanced"]

const firstLine = (s) => (s.split("\n")[0] || "").replace(/^#\s*/, "").trim()

// 遍历每个分组目录下的课程；dir 存完整相对路径（如 basics/L01_agent_loop），
// 这样前端「复制运行命令」用的 lesson.dir 天然带上分组前缀，无需另行拼接
const lessons = SECTIONS.flatMap((section) => {
  const secPath = join(repoRoot, section)
  if (!existsSync(secPath)) return []
  return readdirSync(secPath)
    .filter((name) => /^L\d+_/.test(name) && statSync(join(secPath, name)).isDirectory())
    .map((leaf) => {
      const dir = `${section}/${leaf}`
      const readme = readFileSync(join(repoRoot, dir, "README.md"), "utf8")
      const code = readFileSync(join(repoRoot, dir, "code.ts"), "utf8")
      // 英文 README 可选：存在则一并嵌入，否则前端回落到 TODO 占位
      const enPath = join(repoRoot, dir, "README.en.md")
      const readme_en = existsSync(enPath) ? readFileSync(enPath, "utf8") : ""
      const num = parseInt(leaf.slice(1)) // "L05_..." -> 5
      return { dir, section, num, title: firstLine(readme), title_en: readme_en ? firstLine(readme_en) : "", readme, readme_en, code }
    })
}).sort((a, b) => a.num - b.num) // 跨分组按课号全局排序

writeFileSync(join(docsDir, "lessons.json"), JSON.stringify(lessons, null, 0))
const enCount = lessons.filter((l) => l.readme_en).length
console.log(`已生成 lessons.json：${lessons.length} 课（含英文 README ${enCount} 课）`)
