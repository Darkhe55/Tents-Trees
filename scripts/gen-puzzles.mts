/**
 * 一次性生成静态题库 → src/puzzles-data.ts
 * 用法：npm run gen
 *
 * 流程：
 *   1. 随机撒树（给定密度）
 *   2. 回溯给每棵树配一个「只挨一棵树、不挨别的帐篷」的相邻空格
 *   3. 由帐篷摆放算出行/列线索（本题库给满）
 *   4. 用 countSolutions 校验唯一解，不唯一就重来
 */
import { countSolutions } from '../src/solver.ts'
import { cellIndex, neighbors4 } from '../src/state.ts'
import type { Puzzle } from '../src/types'
import { writeFileSync } from 'node:fs'

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]!
    a[i] = a[j]!
    a[j] = tmp
  }
  return a
}

/**
 * 随机造合法配置：反复「种一棵树 + 在它旁边放一个帐篷」。
 *
 * 维护两个可用性数组，保证合法性是构造出来的：
 *   canTree[i] = i 不挨着任何已放帐篷（否则新树会有两个相邻帐篷）
 *   canTent[i] = i 不挨着已放帐篷（帐篷互不相邻）、不挨着已放树（否则挨两棵树）、自己也不是树
 */
function randomLayout(w: number, h: number, pairs: number, rng: () => number) {
  const total = w * h
  const trees = new Array<boolean>(total).fill(false)
  const tents = new Array<boolean>(total).fill(false)
  const canTree = new Array<boolean>(total).fill(true)
  const canTent = new Array<boolean>(total).fill(true)

  const at = (cx: number, cy: number) => cellIndex(w, cx, cy)

  const place = (treeIdx: number, tentIdx: number) => {
    trees[treeIdx] = true
    tents[tentIdx] = true
    canTree[treeIdx] = false
    canTent[tentIdx] = false
    const tcx = treeIdx % w
    const tcy = Math.floor(treeIdx / w)
    for (const nb of neighbors4(w, h, tcx, tcy)) {
      canTent[at(nb.cx, nb.cy)] = false // 挨着新树的格子不能再当帐篷
    }
    const ccx = tentIdx % w
    const ccy = Math.floor(tentIdx / w)
    for (const nb of neighbors4(w, h, ccx, ccy)) {
      canTent[at(nb.cx, nb.cy)] = false // 帐篷互不相邻
      canTree[at(nb.cx, nb.cy)] = false // 挨着帐篷的格子不能再当树
    }
  }

  let placed = 0
  for (let k = 0; k < pairs; k++) {
    // 候选树：可用，且至少有一个可用的相邻空格
    const candidates: number[] = []
    for (let i = 0; i < total; i++) {
      if (!canTree[i]) continue
      const cx = i % w
      const cy = Math.floor(i / w)
      let hasFree = false
      for (const nb of neighbors4(w, h, cx, cy)) {
        if (canTent[at(nb.cx, nb.cy)]) {
          hasFree = true
          break
        }
      }
      if (hasFree) candidates.push(i)
    }
    if (!candidates.length) break
    const treeIdx = candidates[Math.floor(rng() * candidates.length)]!
    const tcx = treeIdx % w
    const tcy = Math.floor(treeIdx / w)
    const freeNbrs = neighbors4(w, h, tcx, tcy).filter((nb) => canTent[at(nb.cx, nb.cy)])
    const pick = freeNbrs[Math.floor(rng() * freeNbrs.length)]!
    place(treeIdx, at(pick.cx, pick.cy))
    placed++
  }

  if (placed < pairs) return null
  return { trees, tents }
}

interface Spec {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard'
  series: string
  seed: number
  /** 目标帐篷数（树数相同） */
  tents: number
}

const SPECS: Spec[] = [
  { id: 'starter-6x6', name: '入门 · 6×6', width: 6, height: 6, difficulty: 'easy', series: 'starter', seed: 20260301, tents: 8 },
  { id: 'starter-7x7', name: '入门 · 7×7', width: 7, height: 7, difficulty: 'easy', series: 'starter', seed: 20260302, tents: 11 },
  { id: 'classic-8x8-A', name: '经典 · 8×8 A', width: 8, height: 8, difficulty: 'medium', series: 'classic', seed: 20260303, tents: 15 },
  { id: 'classic-8x8-B', name: '经典 · 8×8 B', width: 8, height: 8, difficulty: 'medium', series: 'classic', seed: 20260304, tents: 15 },
  { id: 'classic-9x9', name: '经典 · 9×9', width: 9, height: 9, difficulty: 'medium', series: 'classic', seed: 20260305, tents: 19 },
  { id: 'challenge-10x10', name: '挑战 · 10×10', width: 10, height: 10, difficulty: 'hard', series: 'challenge', seed: 20260306, tents: 23 },
]

function generate(spec: Spec) {
  const { width: w, height: h } = spec
  const t0 = Date.now()

  let layout: { trees: boolean[]; tents: boolean[] } | null = null
  let nodes = 0

  // 造布局 + 唯一解校验，不唯一就换个种子重来
  for (let attempt = 0; attempt < 200 && !layout; attempt++) {
    const rng = mulberry32(spec.seed + attempt * 7919)
    const cand = randomLayout(w, h, spec.tents, rng)
    if (!cand) continue

    const { trees, tents } = cand
    const rowClues: number[] = []
    const colClues: number[] = []
    for (let cy = 0; cy < h; cy++) {
      let n = 0
      for (let cx = 0; cx < w; cx++) if (tents[cellIndex(w, cx, cy)]) n++
      rowClues.push(n)
    }
    for (let cx = 0; cx < w; cx++) {
      let n = 0
      for (let cy = 0; cy < h; cy++) if (tents[cellIndex(w, cx, cy)]) n++
      colClues.push(n)
    }

    const puzzle: Puzzle = {
      id: spec.id,
      name: spec.name,
      width: w,
      height: h,
      trees,
      rowClues,
      colClues,
      difficulty: spec.difficulty,
    }

    const r = countSolutions(puzzle, 2, { maxNodes: 2_000_000, timeBudgetMs: 30_000 })
    nodes = r.nodes
    if (r.count === 1 && !r.timedOut) layout = cand
  }
  if (!layout) throw new Error(`${spec.id}: 200 次尝试都没造出唯一解题目`)

  const { trees, tents } = layout
  const rowClues: number[] = []
  const colClues: number[] = []
  for (let cy = 0; cy < h; cy++) {
    let n = 0
    for (let cx = 0; cx < w; cx++) if (tents[cellIndex(w, cx, cy)]) n++
    rowClues.push(n)
  }
  for (let cx = 0; cx < w; cx++) {
    let n = 0
    for (let cy = 0; cy < h; cy++) if (tents[cellIndex(w, cx, cy)]) n++
    colClues.push(n)
  }

  const treeCount = trees.filter(Boolean).length
  console.log(
    `${spec.id.padEnd(16)} ${w}x${h}  树=${treeCount} 帐篷=${rowClues.reduce((a, b) => a + b, 0)}  唯一解 ✓  ${Date.now() - t0}ms`,
  )

  return {
    id: spec.id,
    name: spec.name,
    width: w,
    height: h,
    difficulty: spec.difficulty,
    series: spec.series,
    trees: trees.map((t) => (t ? '#' : '.')).join(''),
    rows: rowClues.join(','),
    cols: colClues.join(','),
    solution: tents.map((t) => (t ? 'o' : '.')).join(''),
  }
}

const rows = SPECS.map(generate)

const file = `/* 自动生成，勿手改。scripts/gen-puzzles.mts（npm run gen） */
export type RawPuzzle = {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy'|'medium'|'hard'|'custom'
  series: string
  /** 树位图：'#' = 树，'.' = 空地；length = W*H，row-major */
  trees: string
  /** 行线索，逗号分隔，length = H */
  rows: string
  /** 列线索，逗号分隔，length = W */
  cols: string
  /** 参考解：'o' = 帐篷，'.' = 空地；length = W*H，row-major */
  solution: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
${rows
  .map(
    (r) =>
      `  { id: ${JSON.stringify(r.id)}, name: ${JSON.stringify(r.name)}, width: ${r.width}, height: ${r.height}, difficulty: ${JSON.stringify(r.difficulty)}, series: ${JSON.stringify(r.series)}, trees: ${JSON.stringify(r.trees)}, rows: ${JSON.stringify(r.rows)}, cols: ${JSON.stringify(r.cols)}, solution: ${JSON.stringify(r.solution)} },`,
  )
  .join('\n')}
]
`

writeFileSync(new URL('../src/puzzles-data.ts', import.meta.url), file, 'utf8')
console.log('\n已写入 src/puzzles-data.ts')
