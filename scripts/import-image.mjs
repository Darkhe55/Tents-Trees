/**
 * 帐篷（Tents）题面图片导入（自动识图 + 数字 OCR）
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--size N | --width W --height H]
 *                                  [--name 名称] [--id ID] [--rows "a,b,…"] [--cols "a,b,…"]
 *                                  [--map <JSON文件|内联JSON>] [--append] [--verify] [--dry] [--debug]
 *
 * 识图原理：
 *   1. Playwright + Edge 打开图片到 canvas，取像素；
 *   2. 黑线投影定位网格线，拟合出题板尺寸与格距；
 *   3. 每格采样背景色：浅绿(153,255,153)/树冠绿 = 树格，其余 = 空地；
 *   4. 盘外线索：在棋盘上/左留白里取暗色连通域 → 按最近的行/列槽位归组 →
 *      组内按水平间隙切成单个数字 → 多字体模板匹配 OCR；左侧=行帐篷数、上方=列帐篷数；
 *   5. 生成题库格式 trees/rows/cols（solution 留空，需要时可用 --verify 校验）；
 *   6. --append 写入 src/imported-puzzles.ts（不会被 npm run gen 覆盖）；
 *   7. --verify 用项目求解器检查唯一解（30×30 可能超时，只警告）。
 *
 * 数字区域必须用整数像素边界扫描：早期版本把 xs[0] 这类浮点坐标直接当
 * 连通域边界，循环下标变成小数，像素采样得到 NaN，整块区域会被静默读成 0 个数字。
 *
 * 识别不确定时：
 *   - --rows / --cols 覆盖线索：数字=帐篷数，`?`=保留 OCR 结果，空/x = 该行（列）无数字；
 *   - --map 用 JSON 整体修正（width/height/trees/rows/cols，未给的字段保留识别结果）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { build as esbuild } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE_PATH =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

/* ───────────────────────── 参数解析 ───────────────────────── */

const VALUE_FLAGS = new Set([
  '--size',
  '--width',
  '--height',
  '--name',
  '--id',
  '--series',
  '--rows',
  '--cols',
  '--map',
])
const flags = {}
const positional = []
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) {
    positional.push(a)
    continue
  }
  const eq = a.indexOf('=')
  if (eq > 0) {
    flags[a.slice(0, eq)] = a.slice(eq + 1)
  } else if (VALUE_FLAGS.has(a)) {
    flags[a] = process.argv[++i]
  } else {
    flags[a] = true
  }
}
const imageArg = positional[0]
const USAGE =
  '用法：node scripts/import-image.mjs <图片路径> [--size N | --width W --height H] [--name 名称] [--id ID] ' +
  '[--rows "…"] [--cols "…"] [--map <JSON>] [--append] [--verify] [--dry] [--debug]'
if (!imageArg) {
  console.error(USAGE)
  process.exit(1)
}
const imagePath = path.resolve(process.cwd(), imageArg)
if (!existsSync(imagePath)) {
  console.error(`[import] 找不到图片：${imagePath}`)
  process.exit(1)
}

const sizeOpt = Number(flags['--size'] ?? 0) || 0
const widthOpt = Number(flags['--width'] ?? 0) || 0
const heightOpt = Number(flags['--height'] ?? 0) || 0
const strFlag = (key) => (typeof flags[key] === 'string' ? flags[key] : '')
const rowsOverride = strFlag('--rows')
const colsOverride = strFlag('--cols')
const mapArg = strFlag('--map')
const name = strFlag('--name') || path.basename(imagePath, path.extname(imagePath))
const id = strFlag('--id') || `tents-import-${Date.now().toString(36)}`
const series = strFlag('--series') || '导入'
const append = !!flags['--append']
const verify = !!flags['--verify']
const dry = !!flags['--dry']
const debug = !!flags['--debug']

/** 人工修正用的「保留 OCR 值」占位符 */
const KEEP = Symbol('keep')

/** 解析 "7,6,?,x,10" → [7, 6, KEEP, null, 10] */
function parseClueSpec(text) {
  return text.split(',').map((part) => {
    const s = part.trim()
    const lower = s.toLowerCase()
    if (s === '?' || s === '=' || lower === 'keep') return KEEP
    if (s === '' || s === '-' || lower === 'x' || lower === 'null') return null
    const n = Number(s)
    if (!Number.isFinite(n) || n < 0) {
      console.error(`[import] 无法解析线索「${s}」：应为数字 / ? 保留 OCR / 空·x 表示无数字`)
      process.exit(1)
    }
    return n
  })
}

/** 把 `--map` 里可能的线索写法统一成 spec 数组（数字 / null / KEEP） */
function specFromMapValue(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return parseClueSpec(value)
  if (!Array.isArray(value)) {
    console.error('[import] --map 的 rows/cols 应为数组或逗号分隔字符串')
    process.exit(1)
  }
  return value.map((v) => {
    if (v === null || v === undefined || v === '' || v === 'x' || v === '-') return null
    if (v === '?' || v === 'keep') return KEEP
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) {
      console.error(`[import] --map 线索值无法解析：${JSON.stringify(v)}`)
      process.exit(1)
    }
    return n
  })
}

/** 把 --map 里的树位统一成 '#' / '.' 字符串（row-major） */
function treesFromMapValue(value, w, h) {
  if (typeof value === 'string') {
    const flat = [...value]
    if (flat.length === w * h) return value
    const rows = value
      .split(/[\n|;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (rows.length === h && rows.every((r) => [...r].length === w)) return rows.join('')
    console.error(`[import] --map 的 trees 长度应为 ${w * h}（或 ${h} 行 × ${w} 列）`)
    process.exit(1)
  }
  if (Array.isArray(value)) {
    if (value.length === h && value.every((r) => typeof r === 'string')) {
      const rows = value.map((r) => [...r])
      if (rows.every((r) => r.length === w)) {
        return rows.map((r) => r.map((ch) => (ch === '#' || ch === 'o' || ch === '1' ? '#' : '.')).join('')).join('')
      }
    }
    const flat = value
      .flat()
      .map((v) => (v === true || v === 1 || v === '#' || v === 'o' || v === '*' ? '#' : '.'))
    if (flat.length === w * h) return flat.join('')
    console.error(`[import] --map 的 trees 数组长度应为 ${w * h}`)
    process.exit(1)
  }
  console.error('[import] --map 的 trees 应为字符串或数组')
  process.exit(1)
}

let map = null
if (mapArg) {
  let raw = mapArg
  if (existsSync(mapArg)) raw = readFileSync(mapArg, 'utf8')
  try {
    map = JSON.parse(raw)
  } catch (err) {
    console.error(`[import] --map 不是合法 JSON（${mapArg}）：${err.message}`)
    process.exit(1)
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    console.error('[import] --map 应为 JSON 对象：{ width, height, trees, rows, cols }')
    process.exit(1)
  }
}

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

  // ── 3) 盘外线索数字 OCR ──
  const INK = 100 // 黑字阈值：浅灰的行列编号（~153）会落在阈值外，不会被当成线索

  /** 暗色 4 连通域。边界必须取整——传小数会让像素下标变成小数、采样得到 NaN。 */
  const comps = (bx0, by0, bx1, by1) => {
    const x0 = Math.max(0, Math.floor(bx0))
    const y0 = Math.max(0, Math.floor(by0))
    const x1 = Math.min(W, Math.ceil(bx1))
    const y1 = Math.min(H, Math.ceil(by1))
    const seen = new Uint8Array(W * H)
    const out = []
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const k = y * W + x
        if (seen[k] || lum(x, y) >= INK) continue
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
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue
            const nk = ny * W + nx
            if (seen[nk] || lum(nx, ny) >= INK) continue
            seen[nk] = 1
            st.push([nx, ny])
          }
        }
        out.push({
          n,
          cx: sx / n,
          cy: sy / n,
          w: maxX - minX + 1,
          h: maxY - minY + 1,
          minX,
          minY,
          maxX,
          maxY,
        })
      }
    return out
  }

  /** 数字是单字块；书本/边缘的细线、网格线残片按尺寸过滤掉 */
  const isGlyph = (c) =>
    c.n >= 12 &&
    c.h >= cell * 0.16 &&
    c.h <= cell * 1.0 &&
    c.w >= cell * 0.05 &&
    c.w <= cell * 0.75

  /** 两个字挤在一起时按竖直投影的空白列切开 */
  const splitWideGlyph = (c) => {
    if (c.w <= cell * 0.62) return [c]
    const runs = []
    let cur = null
    for (let x = c.minX; x <= c.maxX; x++) {
      let cnt = 0
      for (let y = c.minY; y <= c.maxY; y++) if (lum(x, y) < INK) cnt++
      if (cnt > 0) {
        if (cur) cur.maxX = x
        else cur = { minX: x, maxX: x }
      } else if (cur) {
        runs.push(cur)
        cur = null
      }
    }
    if (cur) runs.push(cur)
    if (runs.length < 2 || runs.length > 4) return [c]
    const out = []
    for (const r of runs) {
      let minY = Infinity
      let maxY = -Infinity
      let n = 0
      for (let y = c.minY; y <= c.maxY; y++)
        for (let x = r.minX; x <= r.maxX; x++)
          if (lum(x, y) < INK) {
            n++
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
      if (n < 12 || maxY - minY + 1 < cell * 0.16) return [c]
      out.push({
        n,
        cx: (r.minX + r.maxX) / 2,
        cy: (minY + maxY) / 2,
        w: r.maxX - r.minX + 1,
        h: maxY - minY + 1,
        minX: r.minX,
        minY,
        maxX: r.maxX,
        maxY,
      })
    }
    return out
  }

  /** 把 bbox 内的字形归一化成 N×N 灰度位图（每个格子取 3×3 子采样，与模板同尺度） */
  const N = 24
  const bitmapOfBox = (minX, minY, maxX, maxY, boxW, boxH, lumAt) => {
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    const bm = new Float32Array(N * N)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        let sum = 0
        let cnt = 0
        for (let sy = -1; sy <= 1; sy++)
          for (let sx = -1; sx <= 1; sx++) {
            const x = Math.round(minX + (i + 0.5 + sx * 0.28) * (bw / N))
            const y = Math.round(minY + (j + 0.5 + sy * 0.28) * (bh / N))
            if (x < 0 || y < 0 || x >= boxW || y >= boxH) continue
            sum += Math.max(0, Math.min(1, (255 - lumAt(x, y)) / 255))
            cnt++
          }
        bm[j * N + i] = cnt ? sum / cnt : 0
      }
    return bm
  }
  const bitmapOfGlyph = (c) => bitmapOfBox(c.minX, c.minY, c.maxX, c.maxY, W, H, lum)

  // 3.1 多字体数字模板：每个数字单独渲染，取暗像素 bbox 归一化
  const fonts = [
    'Arial',
    'Arial Black',
    'Arial Narrow',
    'Segoe UI',
    'Segoe UI Semibold',
    'Segoe UI Black',
    'Helvetica',
    'Verdana',
    'Tahoma',
    'Trebuchet MS',
    'Calibri',
    'Franklin Gothic Medium',
    'Impact',
    'Bahnschrift',
    'Liberation Sans',
    'DejaVu Sans',
    'Noto Sans',
  ]
  const weights = ['bold', 'normal', '600', '900']
  const TCW = 200
  const TCH = 160
  const tcv = document.createElement('canvas')
  tcv.width = TCW
  tcv.height = TCH
  const tg = tcv.getContext('2d', { willReadFrequently: true })
  const templates = []
  for (const font of fonts) {
    for (const weight of weights) {
      const family = `${font} ${weight}`
      const per = []
      let ok = true
      for (let d = 0; d < 10; d++) {
        tg.fillStyle = '#fff'
        tg.fillRect(0, 0, TCW, TCH)
        tg.fillStyle = '#000'
        tg.font = `${weight} 96px "${font}"`
        tg.textBaseline = 'top'
        tg.fillText(String(d), 20, 20)
        const td = tg.getImageData(0, 0, TCW, TCH).data
        const tl = (x, y) => {
          const i = (y * TCW + x) * 4
          return 0.299 * td[i] + 0.587 * td[i + 1] + 0.114 * td[i + 2]
        }
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (let y = 0; y < TCH; y++)
          for (let x = 0; x < TCW; x++)
            if (tl(x, y) < 128) {
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
        if (!Number.isFinite(minX) || maxX - minX + 1 < 6) {
          ok = false
          break
        }
        per.push({
          digit: d,
          family,
          bm: bitmapOfBox(minX, minY, maxX, maxY, TCW, TCH, tl),
        })
      }
      if (ok) templates.push(...per)
    }
  }
  if (templates.length < 10) return { error: '数字 OCR 模板渲染失败' }

  const bitmapDiff = (a, b) => {
    let s = 0
    for (let i = 0; i < N * N; i++) s += Math.abs(a[i] - b[i])
    return s / (N * N)
  }

  /** 单字识别：跨全部字体/字重取最小 L1 距离；margin = 次优「不同数字」的距离差 */
  const readDigit = (c) => {
    const bm = bitmapOfGlyph(c)
    let best = null
    const famMin = new Map()
    for (const t of templates) {
      const diff = bitmapDiff(bm, t.bm)
      if (!best || diff < best.diff) best = { digit: t.digit, diff, family: t.family }
      const prev = famMin.get(t.family)
      if (prev === undefined || diff < prev) famMin.set(t.family, diff)
    }
    let secondDiff = Infinity
    for (const t of templates) {
      if (t.digit === best.digit) continue
      const diff = bitmapDiff(bm, t.bm)
      if (diff < secondDiff) secondDiff = diff
    }
    return {
      digit: best.digit,
      diff: best.diff,
      family: best.family,
      margin: Number.isFinite(secondDiff) ? secondDiff - best.diff : Infinity,
      famMin,
    }
  }

  /** 槽位归组：按数字中心到行/列中心的距离归到最近一格（0.55 格内） */
  const groupByNearest = (list, centers, half, posOf) => {
    const groups = Array.from({ length: centers.length }, () => [])
    for (const item of list) {
      const pos = posOf(item)
      let bi = -1
      let bd = Infinity
      for (let i = 0; i < centers.length; i++) {
        const d = Math.abs(pos - centers[i])
        if (d < bd) {
          bd = d
          bi = i
        }
      }
      if (bi >= 0 && bd <= half) groups[bi].push(item)
    }
    return groups
  }

  /**
   * 组内可能混入灰色行列编号（若它也是深色）：按水平间隙切簇，
   * 取最靠近棋盘的那一簇（左：最右簇；上：最下簇）作为线索数字。
   */
  const pickClueCluster = (items, side) => {
    if (!items.length) return []
    const sorted = items.slice().sort((a, b) => a.cx - b.cx)
    const clusters = []
    for (const item of sorted) {
      const last = clusters[clusters.length - 1]
      const gap = last ? item.minX - last[last.length - 1].maxX : 0
      if (last && gap <= cellX * 0.34) last.push(item)
      else clusters.push([item])
    }
    if (clusters.length <= 1) return clusters[0] ?? []
    let best = clusters[0]
    let bestD = Infinity
    for (const cl of clusters) {
      const near = side === 'left' ? Math.max(...cl.map((c) => c.maxX)) : Math.max(...cl.map((c) => c.maxY))
      const d = side === 'left' ? xs[0] - near : ys[0] - near
      if (d < bestD) {
        bestD = d
        best = cl
      }
    }
    return best
  }

  // 3.2 取盘外暗色字块：留白带按格距缩放，且离网格线预留 0.12 格避开描边抗锯齿
  const rowRegion = [
    xs[0] - cell * 1.7,
    ys[0] + 2,
    xs[0] - cell * 0.12,
    ys[nRows] - 2,
  ]
  const colRegion = [
    xs[0] + cell * 0.12,
    ys[0] - cell * 1.7,
    xs[nCols] - cell * 0.12,
    ys[0] - cell * 0.12,
  ]
  const prep = (raw) => raw.flatMap((c) => (isGlyph(c) ? splitWideGlyph(c) : []))
  const rowGlyphs = prep(comps(...rowRegion))
  const colGlyphs = prep(comps(...colRegion))

  const rowCenters = Array.from({ length: nRows }, (_, i) => ys[0] + (i + 0.5) * cellY)
  const colCenters = Array.from({ length: nCols }, (_, j) => xs[0] + (j + 0.5) * cellX)
  const rowGroups = groupByNearest(rowGlyphs, rowCenters, cellY * 0.55, (c) => c.cy)
  const colGroups = groupByNearest(colGlyphs, colCenters, cellX * 0.55, (c) => c.cx)

  const fontScores = new Map()
  const readClues = (groups, side) => {
    const values = []
    const details = []
    let digitCount = 0
    for (const items of groups) {
      const cluster = pickClueCluster(items, side)
      if (!cluster.length) {
        values.push(null)
        details.push(null)
        continue
      }
      const ordered = cluster.slice().sort((a, b) => a.cx - b.cx)
      let value = 0
      let worst = null
      const digits = []
      for (const c of ordered) {
        const r = readDigit(c)
        digits.push(r.digit)
        value = value * 10 + r.digit
        digitCount++
        if (!worst || r.diff > worst.diff) worst = r
        for (const [fam, d] of r.famMin) {
          const prev = fontScores.get(fam) ?? { sum: 0, n: 0 }
          prev.sum += d
          prev.n++
          fontScores.set(fam, prev)
        }
      }
      values.push(value)
      details.push({
        value,
        digits,
        diff: worst.diff,
        margin: worst.margin,
        family: worst.family,
      })
    }
    return { values, details, digitCount }
  }
  const rowRead = readClues(rowGroups, 'left')
  const colRead = readClues(colGroups, 'top')

  let bestFamily = null
  for (const [fam, s] of fontScores) {
    const avg = s.sum / s.n
    if (!bestFamily || avg < bestFamily.avg) bestFamily = { family: fam, avg }
  }
  const lowConf = (read) =>
    read.details
      .map((d, i) => (d ? { index: i + 1, ...d } : null))
      .filter((d) => d && (d.margin < 0.02 || d.diff > 0.18))
      .map((d) => ({ index: d.index, value: d.value, diff: +d.diff.toFixed(4), margin: +d.margin.toFixed(4) }))
  const overallWorst = Math.max(
    0,
    ...[...rowRead.details, ...colRead.details].filter(Boolean).map((d) => d.diff),
  )

  return {
    W,
    H,
    nCols,
    nRows,
    cell,
    trees,
    rowClues: rowRead.values,
    colClues: colRead.values,
    rowMeta: rowRead.details,
    colMeta: colRead.details,
    digitCount: rowRead.digitCount + colRead.digitCount,
    missingRows: rowRead.values.map((v, i) => (v === null ? i + 1 : 0)).filter(Boolean),
    missingCols: colRead.values.map((v, i) => (v === null ? i + 1 : 0)).filter(Boolean),
    lowConfRows: lowConf(rowRead),
    lowConfCols: lowConf(colRead),
    worstDiff: overallWorst,
    fontGuess: bestFamily ? bestFamily.family : '?',
    fontAvg: bestFamily ? bestFamily.avg : NaN,
    greenCells,
  }
}, dataUrl)
await browser.close()

if (analyzed.error) {
  console.error(`[import] ${analyzed.error}`)
  process.exit(1)
}

/* ───────────────────────── 结果整理 / 人工覆盖 ───────────────────────── */

const { nCols, nRows, cell, trees: detectedTrees } = analyzed
const w = widthOpt || sizeOpt || Number(map?.width) || nCols
const h = heightOpt || sizeOpt || Number(map?.height) || nRows
if (!Number.isInteger(w) || !Number.isInteger(h) || w < 3 || h < 3) {
  console.error(`[import] 棋盘尺寸不合法：${w}×${h}`)
  process.exit(1)
}
if (w !== nCols || h !== nRows) {
  console.error(`[import] 网格不匹配：识别到 ${nCols}×${nRows}，目标 ${w}×${h}`)
  process.exit(1)
}

let treesFinal = detectedTrees
if (map?.trees !== undefined) {
  const treeStr = treesFromMapValue(map.trees, w, h)
  treesFinal = [...treeStr].map((ch) => (ch === '#' || ch === 'o' ? 1 : 0))
  console.log('[import] 使用 --map 覆盖树位')
}
const treeCount = treesFinal.reduce((a, b) => a + b, 0)

const okRows = analyzed.rowClues.filter((v) => v !== null).length
const okCols = analyzed.colClues.filter((v) => v !== null).length
console.log(
  `[import] ${path.basename(imagePath)}：${analyzed.W}×${analyzed.H}，题板 ${w}×${h}，` +
    `格距 ${cell.toFixed(2)}px，树 ${treeCount} 棵（绿色格 ${analyzed.greenCells}）`,
)
console.log(
  `[import] 线索识别：行 ${okRows}/${h} · 列 ${okCols}/${w} · 数字字块 ${analyzed.digitCount} 个` +
    ` · 最接近字体 ${analyzed.fontGuess}（平均误差 ${Number.isFinite(analyzed.fontAvg) ? analyzed.fontAvg.toFixed(4) : '?'}` +
    ` · 最差单字 ${analyzed.worstDiff.toFixed(4)}）`,
)
if (analyzed.missingRows.length) {
  console.warn(`[import] 未读到数字的行（1 起）：${analyzed.missingRows.join(', ')}`)
}
if (analyzed.missingCols.length) {
  console.warn(`[import] 未读到数字的列（1 起）：${analyzed.missingCols.join(', ')}`)
}
if (analyzed.lowConfRows.length) {
  console.warn(
    `[import] 低置信行线索：${analyzed.lowConfRows
      .map((d) => `第${d.index}行=${d.value}(误差${d.diff})`)
      .join('、')}`,
  )
}
if (analyzed.lowConfCols.length) {
  console.warn(
    `[import] 低置信列线索：${analyzed.lowConfCols
      .map((d) => `第${d.index}列=${d.value}(误差${d.diff})`)
      .join('、')}`,
  )
}
if (debug) {
  const dump = (label, meta) => {
    console.log(`[import][debug] ${label}逐项：`)
    meta.forEach((d, i) => {
      if (!d) {
        console.log(`  ${String(i + 1).padStart(2)}: (无数字)`)
        return
      }
      console.log(
        `  ${String(i + 1).padStart(2)}: ${d.value}  digits=[${d.digits.join(',')}]` +
          ` diff=${d.diff.toFixed(4)} margin=${Number.isFinite(d.margin) ? d.margin.toFixed(4) : '∞'}`,
      )
    })
  }
  dump('行', analyzed.rowMeta)
  dump('列', analyzed.colMeta)
}

/** 合并 OCR 与新线索 spec：KEEP 保留 OCR 值，null 表示该行/列没有数字 */
const mergeClues = (ocr, spec, expectedLen, label) => {
  if (!spec) return ocr.slice()
  if (spec.length !== expectedLen) {
    console.error(
      `[import] ${label}线索数量 ${spec.length} ≠ 目标 ${expectedLen}；请给满 ${expectedLen} 项（?=保留 OCR，x/空=无数字）`,
    )
    process.exit(1)
  }
  return spec.map((v, i) => (v === KEEP ? (ocr[i] ?? null) : v))
}

let rowSums = mergeClues(
  analyzed.rowClues,
  rowsOverride ? parseClueSpec(rowsOverride) : null,
  h,
  '行',
)
let colSums = mergeClues(
  analyzed.colClues,
  colsOverride ? parseClueSpec(colsOverride) : null,
  w,
  '列',
)
if (rowsOverride) console.log('[import] 使用 --rows 覆盖行线索')
if (colsOverride) console.log('[import] 使用 --cols 覆盖列线索')
if (map?.rows !== undefined) {
  rowSums = mergeClues(rowSums, specFromMapValue(map.rows), h, '行')
  console.log('[import] 使用 --map 覆盖行线索')
}
if (map?.cols !== undefined) {
  colSums = mergeClues(colSums, specFromMapValue(map.cols), w, '列')
  console.log('[import] 使用 --map 覆盖列线索')
}

const fmtClues = (arr) => arr.map((v) => (v === null || v === undefined ? '?' : v)).join(',')
console.log(`[import] 行线索：${fmtClues(rowSums)}`)
console.log(`[import] 列线索：${fmtClues(colSums)}`)

const nullRows = rowSums.map((v, i) => (v === null ? i + 1 : 0)).filter(Boolean)
const nullCols = colSums.map((v, i) => (v === null ? i + 1 : 0)).filter(Boolean)
if (nullRows.length) console.warn(`[import] 以下行没有线索数字（1 起）：${nullRows.join(', ')}`)
if (nullCols.length) console.warn(`[import] 以下列没有线索数字（1 起）：${nullCols.join(', ')}`)
console.log(`[import] 线索就绪：行 ${h - nullRows.length}/${h} · 列 ${w - nullCols.length}/${w}`)

const sumRows = rowSums.reduce((a, b) => a + (b ?? 0), 0)
const sumCols = colSums.reduce((a, b) => a + (b ?? 0), 0)
if (!nullRows.length && !nullCols.length) {
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
  console.warn('[import] 警告：线索有缺口，行列合计无法校验')
}

// 预览
console.log('[import] 树位预览：')
for (let y = 0; y < h; y++) {
  let line = '  '
  for (let x = 0; x < w; x++) line += treesFinal[y * w + x] ? ' T' : ' ·'
  console.log(line)
}

const serializeClues = (arr) => arr.map((v) => (v === null || v === undefined ? '' : String(v))).join(',')
const treesStr = treesFinal.map((v) => (v ? '#' : '.')).join('')
const rowsStr = serializeClues(rowSums)
const colsStr = serializeClues(colSums)

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
    trees: treesFinal.map(Boolean),
    rowClues: rowSums,
    colClues: colSums,
  }
  const t0 = Date.now()
  const res = countSolutions(puzzle, 2, { maxNodes: 2_000_000, timeBudgetMs: 30_000 })
  const ms = Date.now() - t0
  if (res.timedOut) {
    console.warn(`[import] 唯一性检查超时（${res.nodes} 节点 / ${ms}ms），无法确认唯一解`)
  } else if (res.count === 0) {
    console.error(
      '[import] 无解：树位置或线索识别可能有误；也可能题面本身不满足「树–帐篷一一配对」的官方规则',
    )
  } else if (res.count >= 2) {
    console.warn(`[import] 解不唯一：至少 ${res.count} 个（${res.nodes} 节点 / ${ms}ms）`)
  } else {
    console.log(`[import] 唯一解检查通过（${res.nodes} 节点 / ${ms}ms）`)
  }
}

if (dry) {
  console.log(`[import] --dry：仅识别${verify ? '并做唯一解检查' : ''}，不写入。`)
  process.exit(0)
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
