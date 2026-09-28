// T003 (scripts/copy-pdf-worker.mjs): 复制 pdf.js worker 到 resources/，禁止 CDN（research R6）
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.mjs")
const dest = join(root, "resources", "pdf.worker.mjs")

if (!existsSync(src)) {
  console.warn(`[copy-pdf-worker] source not found, skipped: ${src}`)
  process.exit(0)
}
mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log(`[copy-pdf-worker] ${src} -> ${dest}`)
