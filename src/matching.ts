/**
 * 二分图最大匹配（Kuhn 增广路）。
 *
 * 帐篷的官方语义是「存在完整的一对一配对」：
 *   - 每条树–帐篷边表示两者正交相邻；
 *   - 一顶帐篷可以同时挨多棵树，一棵树也可以同时挨多顶帐篷；
 *   - 只要所有树和所有帐篷能被一一配对就合法。
 *
 * 所以校验与求解的核心都归结为二分图匹配可行性，而不是「每棵树/每顶帐篷
 * 在局部都恰好只挨一个」。
 */
import { cellIndex, neighbors4 } from './state'
import type { GameState, Puzzle } from './types'
import { CellState as CS } from './types'
export interface MatchingResult {
  /** 匹配边数 */
  size: number
  /** 左节点 → 右节点编号；-1 = 未匹配 */
  leftMatch: Int32Array
  /** 右节点 → 左节点编号；-1 = 未匹配 */
  rightMatch: Int32Array
}

/** 二分图最大匹配。leftAdj[i] = 左节点 i 可匹配的右节点编号列表 */
export function maximumMatching(
  leftAdj: ReadonlyArray<ReadonlyArray<number>>,
  rightCount: number,
): MatchingResult {
  const rightMatch = new Int32Array(rightCount).fill(-1)
  const leftMatch = new Int32Array(leftAdj.length).fill(-1)
  if (!leftAdj.length || rightCount === 0) return { size: 0, leftMatch, rightMatch }
  const seen = new Int32Array(rightCount).fill(-1)
  let stamp = 0

  const tryAugment = (li: number): boolean => {
    const adj = leftAdj[li]!
    for (let k = 0; k < adj.length; k++) {
      const ri = adj[k]!
      if (seen[ri] === stamp) continue
      seen[ri] = stamp
      const owner = rightMatch[ri]!
      if (owner === -1 || tryAugment(owner)) {
        rightMatch[ri] = li
        leftMatch[li] = ri
        return true
      }
    }
    return false
  }

  let size = 0
  for (let li = 0; li < leftAdj.length; li++) {
    stamp++
    if (tryAugment(li)) size++
  }
  return { size, leftMatch, rightMatch }
}

/**
 * 树侧候选格：与该树正交相邻、且满足 accept 的格子。
 * @param treeCells 树格索引（row-major 顺序，和返回的邻接表一一对应）
 */
export function treeCandidateAdjacency(
  puzzle: Puzzle,
  treeCells: ReadonlyArray<number>,
  accept: (index: number) => boolean,
): number[][] {
  const w = puzzle.width
  const h = puzzle.height
  const out: number[][] = new Array(treeCells.length)
  for (let ti = 0; ti < treeCells.length; ti++) {
    const index = treeCells[ti]!
    const cx = index % w
    const cy = Math.floor(index / w)
    const adj: number[] = []
    for (const nb of neighbors4(w, h, cx, cy)) {
      const j = cellIndex(w, nb.cx, nb.cy)
      if (accept(j)) adj.push(j)
    }
    out[ti] = adj
  }
  return out
}

/** 某格正交相邻的树格索引 */
export function adjacentTrees(puzzle: Puzzle, index: number): number[] {
  const w = puzzle.width
  const h = puzzle.height
  const cx = index % w
  const cy = Math.floor(index / w)
  const out: number[] = []
  for (const nb of neighbors4(w, h, cx, cy)) {
    const j = cellIndex(w, nb.cx, nb.cy)
    if (puzzle.trees[j]) out.push(j)
  }
  return out
}

/** 当前盘面里所有树格（row-major） */
export function treeCellsOf(puzzle: Puzzle): number[] {
  const out: number[] = []
  for (let i = 0; i < puzzle.trees.length; i++) if (puzzle.trees[i]) out.push(i)
  return out
}

/**
 * 树侧可行性：每棵还没有帐篷的树，能否从 candidates 里各分到一格格子。
 * 用来做搜索剪枝 / 逻辑推理。
 */
export function treesCanBeCovered(
  puzzle: Puzzle,
  treeCells: ReadonlyArray<number>,
  candidates: (index: number) => boolean,
): boolean {
  if (!treeCells.length) return true
  const adj = treeCandidateAdjacency(puzzle, treeCells, candidates)
  return maximumMatching(adj, puzzle.width * puzzle.height).size === treeCells.length
}

/**
 * 帐篷侧可行性：已放的帐篷能否各自配到一棵不同的树。
 * 只看已放帐篷（局部相邻树），不关心未来格子。
 */
export function tentsCanBeMatched(puzzle: Puzzle, tentCells: ReadonlyArray<number>): boolean {
  if (!tentCells.length) return true
  const adj = tentCells.map((index) => adjacentTrees(puzzle, index))
  return maximumMatching(adj, puzzle.width * puzzle.height).size === tentCells.length
}

/** 从盘面收集帐篷格索引 */
export function tentCellsOf(state: GameState, puzzle: Puzzle): number[] {
  const out: number[] = []
  for (let i = 0; i < state.cells.length; i++) {
    if (puzzle.trees[i]) continue
    if (state.cells[i] === CS.Tent) out.push(i)
  }
  return out
}
