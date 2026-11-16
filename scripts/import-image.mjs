/**
 * 帐篷（Tents）题面图片导入（自动识图 + 数字 OCR）
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--size N | --width W --height H]
 *                                  [--name 名称] [--id ID] [--rows "a,b,…"] [--cols "a,b,…"]
 *                                  [--append] [--verify] [--dry]
 *
 * 识图原理：
 *   1. Playwright + Edge 打开图片到 canvas，取像素；
 *   2. 黑线投影定位网格线，拟合出题板尺寸与格距；
 *   3. 每格采样背景色：浅绿(153,255,153)/树冠绿 = 树格，其余 = 空地；
 *   4. 盘外粗体数字用「多字体模板匹配」OCR：左侧=行帐篷数、上方=列帐篷数；
 *   5. 生成题库格式 trees/rows/cols（solution 留空，需要时可用 --verify 校验）；
 *   6. --append 写入 src/imported-puzzles.ts（不会被 npm run gen 覆盖）；
 *   7. --verify 用项目求解器检查唯一解（30×30 可能超时，只警告）。
 *
 * 识别不确定时用 --rows / --cols 覆盖线索，或 --width/--height 覆盖棋盘尺寸。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { build as esbuild } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_PATH =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  if (i < 0) return fallback
  return process.argv[i + 1] ?? fallback
}
function has(name) {
  return process.argv.includes(name)
}

const imageArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!imageArg) {
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--size N | --width W --height H] [--name 名称] [--id ID] [--rows "…"] [--cols "…"] [--append] [--verify] [--dry]',
  )
  process.exit(1)
}
const imagePath = path.resolve(process.cwd(), imageArg)
if (!existsSync(imagePath)) {
  console.error(`[import] 找不到图片：${imagePath}`)
  process.exit(1)
}

const sizeOpt = Number(arg('--size', '0')) || 0
const widthOpt = Number(arg('--width', '0')) || 0
const heightOpt = Number(arg('--height', '0')) || 0
const rowsOverride = arg('--rows', '')
const colsOverride = arg('--cols', '')
const name = arg('--name', path.basename(imagePath, path.extname(imagePath)))
const id = arg('--id', `tents-import-${Date.now().toString(36)}`)
const series = arg('--series', '导入')
const append = has('--append')
const verify = has('--verify')
const dry = has('--dry')

/* ───────────────────────── 识图（浏览器内） ───────────────────────── */

const dataUrl = `data:image/png;base64,${readFileSync(imagePath).toString('base64')}`
const browser = await chromium.launch({ headless: true, executablePath: EDGE_PATH })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const analyzed = await page.evaluate(async (url) => {
  const img = new Image()
  img.src = url
  await img.decode()
  const W = img.naturalWidth
  const H = img.naturalHeight
  const cv = document.getElementById('c')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const px = g.getImageData(0, 0, W, H).data
  const lum = (x, y) => {
    const i = (y * W + x) * 4
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
  }
  const rgb = (x, y) => {
    const i = (y * W + x) * 4
    return [px[i], px[i + 1], px[i + 2]]
  }

  // ── 1) 黑色网格线投影 ──
  const colDark = new Int32Array(W)
  const rowDark = new Int32Array(H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (lum(x, y) < 110) {
        colDark[x]++
        rowDark[y]++
      }
  const pickLines = (arr, frac, total) => {
    const thr = total * frac
    const out = []
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] <= thr) continue
      let j = i
      while (j + 1 < arr.length && arr[j + 1] > thr) j++
      out.push((i + j) / 2)
      i = j
    }
    return out
  }
  const dedupe = (arr, gap = 5) => {
    const out = []
    for (const v of arr) {
      if (!out.length || v - out[out.length - 1] > gap) out.push(v)
      else out[out.length - 1] = (out[out.length - 1] + v) / 2
    }
    return out
  }
  let xs = dedupe(pickLines(colDark, 0.45, W))
  let ys = dedupe(pickLines(rowDark, 0.45, H))
  // 用等距假设修正：取中位间距，把偏差 > 0.4 格的线当作噪声剔除
  const refine = (lines) => {
    if (lines.length < 3) return lines
    const gaps = []
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i] - lines[i - 1])
    gaps.sort((a, b) => a - b)
    const gap = gaps[Math.floor(gaps.length / 2)]
    const first = lines[0]
    const last = lines[lines.length - 1]
    const n = Math.round((last - first) / gap)
    const out = []
    for (let i = 0; i <= n; i++) out.push(first + (i * (last - first)) / n)
    return out
  }
  xs = refine(xs)
  ys = refine(ys)
  const nCols = xs.length - 1
  const nRows = ys.length - 1
  if (nCols < 3 || nRows < 3) return { error: `网格识别失败：${nCols}×${nRows}` }
  const cellX = (xs[nCols] - xs[0]) / nCols
  const cellY = (ys[nRows] - ys[0]) / nRows
  const cell = (cellX + cellY) / 2

  // ── 2) 树格：绿色背景/树冠 ──
  const isGreen = (x, y) => {
    const [r, gg, b] = rgb(x, y)
    return gg > r + 25 && gg > b + 25
  }
  const trees = new Array(nCols * nRows).fill(0)
  let greenCells = 0
  for (let r = 0; r < nRows; r++)
    for (let c = 0; c < nCols; c++) {
      const cx = Math.round(xs[0] + (c + 0.5) * cellX)
      const cy = Math.round(ys[0] + (r + 0.5) * cellY)
      let green = 0
      let n = 0
      for (let oy = -3; oy <= 3; oy++)
        for (let ox = -3; ox <= 3; ox++) {
          n++
          if (isGreen(cx + ox, cy + oy)) green++
        }
      if (green / n > 0.35) {
        trees[r * nCols + c] = 1
        greenCells++
      }
    }

  // ── 3) 线索数字 OCR（与温度计同一套多字体模板匹配） ──
  const comps = (bx0, by0, bx1, by1) => {
    const seen = new Uint8Array(W * H)
    const out = []
    for (let y = Math.max(0, by0); y < Math.min(H, by1); y++)
      for (let x = Math.max(0, bx0); x < Math.min(W, bx1); x++) {
        const k = y * W + x
        if (seen[k] || lum(x, y) >= 100) continue
        let n = 0
        let sx = 0
        let sy = 0
        let minX = x
        let maxX = x
        let minY = y
        let maxY = y
        const st = [[x, y]]
        seen[k] = 1
        while (st.length) {
          const [cx, cy] = st.pop()
          n++
          sx += cx
          sy += cy
          if (cx < minX) minX = cx
          if (cx > maxX) maxX = cx
          if (cy < minY) minY = cy
          if (cy > maxY) maxY = cy
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < bx0 || ny < by0 || nx >= bx1 || ny >= by1) continue
            const nk = ny * W + nx
            if (seen[nk] || lum(nx, ny) >= 100) continue
            seen[nk] = 1
            st.push([nx, ny])
          }
        }
        out.push({ n, cx: sx / n, cy: sy / n, w: maxX - minX + 1, h: maxY - minY + 1, minX, minY, maxX, maxY })
      }
    return out
  }
  const glyphFilter = (arr) =>
    arr.filter((c) => c.n >= 15 && c.h >= cell * 0.25 && c.h <= cell * 0.95 && c.w <= cell * 1.1)
  const rowGlyphs = glyphFilter(comps(Math.round(xs[0] - cell * 1.35), ys[0], Math.round(xs[0] - 2), ys[nRows]))
  const colGlyphs = glyphFilter(comps(xs[0], Math.round(ys[0] - cell * 1.35), xs[nCols], Math.round(ys[0] - 2)))
  const groupLines = (arr, key, tol) => {
    const sorted = arr.slice().sort((a, b) => a[key] - b[key])
    const lines = []
    for (const c of sorted) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(c[key] - last.avg) <= tol) {
        last.items.push(c)
        last.avg = last.items.reduce((s, m) => s + m[key], 0) / last.items.length
      } else lines.push({ avg: c[key], items: [c] })
    }
    for (const l of lines) l.items.sort((a, b) => a.cx - b.cx)
    return lines
  }
  const dbg = { xs0: xs[0], xsN: xs[nCols], ys0: ys[0], ysN: ys[nRows], rowGlyphs: rowGlyphs.length, colGlyphs: colGlyphs.length, rowLines: rowLines0(rowGlyphs).length }
  function rowLines0(g) { return g }
  console.log('[import][debug] ' + JSON.stringify(dbg))
  const rowLines = groupLines(rowGlyphs, 'cy', cell * 0.42)
  const colLines = groupLines(colGlyphs, 'cx', cell * 0.42)

  const N = 20
  const glyphBitmap = (c) => {
    const bw = c.maxX - c.minX + 1
    const bh = c.maxY - c.minY + 1
    const bm = new Float32Array(N * N)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        let sum = 0
        let cnt = 0
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            const pxx = Math.round(c.minX + ((i + 0.5) * bw) / N + ox * 0.7)
            const pyy = Math.round(c.minY + ((j + 0.5) * bh) / N + oy * 0.7)
            if (pxx < 0 || pyy < 0 || pxx >= W || pyy >= H) continue
            sum += Math.max(0, Math.min(1, (255 - lum(pxx, pyy)) / 255))
            cnt++
          }
        bm[j * N + i] = cnt ? sum / cnt : 0
      }
    return bm
  }
  const fonts = [
    'Arial',
    'Arial Black',
    'Helvetica',
    'Verdana',
    'Tahoma',
    'Trebuchet MS',
    'Segoe UI',
    'Calibri',
    'Franklin Gothic Medium',
    'Liberation Sans',
    'DejaVu Sans',
    'Noto Sans',
  ]
  const tcv = document.createElement('canvas')
  tcv.width = 520
  tcv.height = 120
  const tg = tcv.getContext('2d', { willReadFrequently: true })
  const renderTemplates = (font, weight) => {
    tg.fillStyle = '#fff'
    tg.fillRect(0, 0, 520, 120)
    tg.fillStyle = '#000'
    tg.font = `${weight} 70px "${font}"`
    tg.textBaseline = 'top'
    tg.fillText('0123456789', 4, 6)
    const td = tg.getImageData(0, 0, 520, 120).data
    const tl = (x, y) => {
      const i = (y * 520 + x) * 4
      return 0.299 * td[i] + 0.587 * td[i + 1] + 0.114 * td[i + 2]
    }
    const seenT = new Uint8Array(520 * 120)
    const out = []
    for (let y = 0; y < 120; y++)
      for (let x = 0; x < 520; x++) {
        const k = y * 520 + x
        if (seenT[k] || tl(x, y) > 128) continue
        let n = 0
        let minX = x
        let maxX = x
        let minY = y
        let maxY = y
        const st = [[x, y]]
        seenT[k] = 1
        while (st.length) {
          const [cx, cy] = st.pop()
          n++
          if (cx < minX) minX = cx
          if (cx > maxX) maxX = cx
          if (cy < minY) minY = cy
          if (cy > maxY) maxY = cy
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= 520 || ny >= 120) continue
            const nk = ny * 520 + nx
            if (seenT[nk] || tl(nx, ny) > 128) continue
            seenT[nk] = 1
            st.push([nx, ny])
          }
        }
        out.push({ n, minX, maxX, minY, maxY })
      }
    const glyphs = out.filter((c) => c.n > 30).sort((a, b) => a.minX - b.minX).slice(0, 10)
    if (glyphs.length !== 10) return null
    return glyphs.map((c) => {
      const bw = c.maxX - c.minX + 1
      const bh = c.maxY - c.minY + 1
      const bm = new Float32Array(N * N)
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          let sum = 0
          let cnt = 0
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const pxx = Math.round(c.minX + ((i + 0.5) * bw) / N + ox * 0.7)
              const pyy = Math.round(c.minY + ((j + 0.5) * bh) / N + oy * 0.7)
              if (pxx < 0 || pyy < 0 || pxx >= 520 || pyy >= 120) continue
              sum += Math.max(0, Math.min(1, (255 - tl(pxx, pyy)) / 255))
              cnt++
            }
          bm[j * N + i] = cnt ? sum / cnt : 0
        }
      return bm
    })
  }
  const bitmapDiff = (a, b) => {
    let s = 0
    for (let i = 0; i < N * N; i++) s += Math.abs(a[i] - b[i])
    return s / (N * N)
  }
  const allBitmaps = [...rowGlyphs, ...colGlyphs].map(glyphBitmap)
  let bestFont = null
  for (const font of fonts)
    for (const weight of ['bold', 'normal']) {
      const templates = renderTemplates(font, weight)
      if (!templates) continue
      let total = 0
      for (const bm of allBitmaps) {
        let m = Infinity
        for (const t of templates) m = Math.min(m, bitmapDiff(bm, t))
        total += m
      }
      const avg = total / Math.max(1, allBitmaps.length)
      if (!bestFont || avg < bestFont.avg) bestFont = { name: `${font} ${weight}`, templates, avg }
    }
  if (!bestFont) return { error: '数字 OCR 模板渲染失败' }
  const digitOf = (bm) => {
    let best = -1
    let bestDiff = Infinity
    bestFont.templates.forEach((t, i) => {
      const diff = bitmapDiff(bm, t)
      if (diff < bestDiff) {
        bestDiff = diff
        best = i
      }
    })
    return best
  }
  const readLines = (lines) =>
    lines.map((line) => line.items.map((c) => digitOf(glyphBitmap(c))).reduce((a, d) => a * 10 + d, 0))
  return {
    W,
    H,
    nCols,
    nRows,
    cell,
    trees,
    rowClues: readLines(rowLines),
    colClues: readLines(colLines),
    fontGuess: bestFont.name,
    fontAvg: bestFont.avg,
    greenCells,
  }
}, dataUrl)
await browser.close()

if (analyzed.error) {
  console.error(`[import] ${analyzed.error}`)
  process.exit(1)
}
const { nCols, nRows, cell, trees } = analyzed
const w = widthOpt || sizeOpt || nCols
const h = heightOpt || sizeOpt || nRows
if (w !== nCols || h !== nRows) {
  console.error(`[import] 网格不匹配：识别到 ${nCols}×${nRows}，目标 ${w}×${h}`)
  process.exit(1)
}
const treeCount = trees.reduce((a, b) => a + b, 0)
console.log(
  `[import] ${path.basename(imagePath)}：${analyzed.W}×${analyzed.H}，题板 ${w}×${h}，` +
    `格距 ${cell.toFixed(2)}px，树 ${treeCount} 棵（绿色格 ${analyzed.greenCells}）`,
)
console.log(`[import] OCR 字体猜测：${analyzed.fontGuess}（平均误差 ${analyzed.fontAvg.toFixed(4)}）`)

const parseClueList = (text) =>
  text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
let rowSums = rowsOverride ? parseClueList(rowsOverride) : analyzed.rowClues
let colSums = colsOverride ? parseClueList(colsOverride) : analyzed.colClues
if (rowsOverride) console.log('[import] 使用 --rows 覆盖行线索')
if (colsOverride) console.log('[import] 使用 --cols 覆盖列线索')
console.log(`[import] 行线索：${rowSums.join(',')}`)
console.log(`[import] 列线索：${colSums.join(',')}`)
const sumRows = rowSums.reduce((a, b) => a + b, 0)
const sumCols = colSums.reduce((a, b) => a + b, 0)
if (rowSums.length === h && colSums.length === w) {
  if (sumRows !== sumCols) {
    console.warn(`[import] 警告：行线索合计 ${sumRows} ≠ 列线索合计 ${sumCols}，OCR 可能读错`)
  } else if (sumRows !== treeCount) {
    console.warn(
      `[import] 警告：帐篷合计 ${sumRows} ≠ 树数 ${treeCount}（每个树配一个帐篷，应当相等），识别可能有误`,
    )
  } else {
    console.log(`[import] 校验：行/列合计一致且等于树数 ${treeCount} ✓`)
  }
} else {
  console.warn(
    `[import] 警告：OCR 到 ${rowSums.length} 行 / ${colSums.length} 列线索，与 ${h}×${w} 不符；可用 --rows/--cols 覆盖`,
  )
}

// 预览
console.log('[import] 树位预览：')
for (let y = 0; y < h; y++) {
  let line = '  '
  for (let x = 0; x < w; x++) line += trees[y * w + x] ? ' T' : ' ·'
  console.log(line)
}

const treesStr = trees.map((v) => (v ? '#' : '.')).join('')
const rowsStr = rowSums.join(',')
const colsStr = colSums.join(',')

if (dry) {
  console.log('[import] --dry：仅识别，不写入。')
  process.exit(0)
}

if (verify) {
  const bundleFile = path.join(ROOT, 'node_modules', '.cache', 'import-verify-tents.mjs')
  await esbuild({
    absWorkingDir: ROOT,
    stdin: {
      contents: `export { countSolutions } from './src/solver.ts'`,
      resolveDir: ROOT,
      sourcefile: 'import-verify-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundleFile,
    logLevel: 'silent',
  })
  const { countSolutions } = await import(pathToFileURL(bundleFile).href)
  const puzzle = {
    id,
    name,
    width: w,
    height: h,
    difficulty: 'custom',
    trees: trees.map(Boolean),
    rowClues: rowSums,
    colClues: colSums,
  }
  const t0 = Date.now()
  const res = countSolutions(puzzle, 2, { maxNodes: 2_000_000, timeBudgetMs: 30_000 })
  const ms = Date.now() - t0
  if (res.timedOut) {
    console.warn(`[import] 唯一性检查超时（${res.nodes} 节点 / ${ms}ms），无法确认唯一解`)
  } else if (res.count === 0) {
    console.error('[import] 无解：树位置或线索识别可能有误')
  } else if (res.count >= 2) {
    console.warn(`[import] 解不唯一：至少 ${res.count} 个（${res.nodes} 节点 / ${ms}ms）`)
  } else {
    console.log(`[import] 唯一解检查通过（${res.nodes} 节点 / ${ms}ms）`)
  }
}

if (!append) {
  console.log('[import] 预览模式（未写入）。加 --append 可写入 src/imported-puzzles.ts')
  process.exit(0)
}

const file = path.join(ROOT, 'src/imported-puzzles.ts')
const entry = `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${w}, height: ${h}, difficulty: "custom", series: ${JSON.stringify(series)}, trees: ${JSON.stringify(treesStr)}, rows: ${JSON.stringify(rowsStr)}, cols: ${JSON.stringify(colsStr)}, solution: "" },\n`
if (!existsSync(file)) {
  writeFileSync(
    file,
    `/* 由 scripts/import-image.mjs 追加，npm run gen 不会覆盖。 */\nimport type { RawPuzzle } from './puzzles-data.ts'\n\nexport const IMPORTED_PUZZLES: RawPuzzle[] = [\n${entry}]\n`,
  )
} else {
  let text = readFileSync(file, 'utf8')
  if (text.includes('IMPORTED_PUZZLES: RawPuzzle[] = []')) {
    text = text.replace('IMPORTED_PUZZLES: RawPuzzle[] = []', `IMPORTED_PUZZLES: RawPuzzle[] = [\n${entry}]`)
  } else {
    const marker = text.lastIndexOf('\n]')
    if (marker < 0) throw new Error('imported-puzzles.ts 格式异常，找不到数组结尾')
    text = text.slice(0, marker + 1) + entry + text.slice(marker + 1)
  }
  writeFileSync(file, text)
}
console.log(`[import] 已写入 ${file}`)
