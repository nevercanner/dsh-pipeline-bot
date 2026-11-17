/**
 * 构建脚本：src/*.ts → lib/*.js，用 Node 内置的 `module.stripTypeScriptTypes`。
 *
 * 为什么不用 tsc / esbuild：插件的硬要求是「装上就能跑」，不能在安装路径上
 * 依赖一个可能缺席的 devDependency；Node >= 22.6 自带 strip 能力，行为与
 * `--experimental-strip-types` 一致。转译只剥类型，不做类型检查
 * （类型检查请跑 `npm run typecheck`，需要 checkout 的 tsc）。
 *
 * 产物：
 *   lib/index.js    ← src/index.ts（相对 import 改写成 .js）
 *   lib/*.js        ← 其余 src 子模块，保持相对结构
 *   lib/client.js   ← src/client/index.ts（Client 半，ModuleLoader.load 形态）
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcDir = join(root, 'src')
const outDir = join(root, 'lib')

async function ensureDir(dir) {
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EEXIST') throw error
  }
}

async function walk(dir) {
  const output = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) output.push(...(await walk(full)))
    else if (entry.name.endsWith('.ts')) output.push(full)
  }
  return output
}

/** `.ts` → `.js`：产物里必须指向真实存在的文件。 */
function rewriteImports(code) {
  return code
    .replace(/(from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3')
    .replace(/(export\s+\*\s+from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
}

/**
 * Client 半必须是**经典脚本**（`window.__ModuleLoader__.load({...})`），
 * 不能带任何 ESM 关键字 —— 宿主按普通 script 注入它，`export` 会直接变成
 * 语法错误，表现为「已声明 client 但注册失败」。
 *
 * 但源码里保留 `export const inject = ['slots']` 是有用的：
 * 注入器的落盘校验靠它确认「apply 用 ctx.slots 就必须声明 inject」。
 * 所以：源文件保留 export，构建产物剥成普通 const。
 */
function stripEsmForClient(code) {
  return code.replace(/^export\s+(const|let|var|function|async\s+function)\s/gm, '$1 ')
}

async function main() {
  if (!existsSync(srcDir)) throw new Error(`缺少 src 目录：${srcDir}`)
  await ensureDir(outDir)
  const files = await walk(srcDir)
  let count = 0
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const relative = file.slice(srcDir.length + 1)
    // client 半独立打包成单文件 lib/client.js（ModuleLoader.load 形态）
    const target =
      relative.split(sep).join('/') === 'client/index.ts'
        ? join(outDir, 'client.js')
        : join(outDir, relative.replace(/\.ts$/, '.js'))
    const isClient = relative.split(sep).join('/') === 'client/index.ts'
    let code = stripTypeScriptTypes(source, { mode: 'strip' })
    code = rewriteImports(code)
    if (isClient) code = stripEsmForClient(code)
    await ensureDir(dirname(target))
    await writeFile(target, code, 'utf8')
    count += 1
  }
  console.log(`built ${count} file(s) → ${outDir}`)
}

await main()
