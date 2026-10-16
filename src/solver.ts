/**
 * 帐篷求解器（回溯 + 剪枝），用于题库生成的唯一解校验。
 *
 * 剪枝：
 *  - 行/列：已放帐篷数 ≤ 线索，且已放 + 剩余空地 ≥ 线索
 *  - 树：相邻帐篷数 ≤ 1；若相邻空地已用完则必须恰好 1 个
 *  - 帐篷：放下的瞬间就要满足「恰好挨一棵树」且「不与别的帐篷相邻（含斜角）」
 */
import { cellIndex, cellValue, createEmptyState, neighbors4, neighbors8, treePositions } from './state'
import type { CellState, GameState, Puzzle } from './types'
import { CellState as CS } from './types'

export interface CountResult {
  count: number
  capped: boolean
  nodes: number
  timedOut: boolean
  first: GameState | null
  second: GameState | null
}

export interface SearchOptions {
  maxNodes?: number
  timeBudgetMs?: number
}

class Searcher {
  readonly w: number
  readonly h: number
  private readonly puzzle: Puzzle
  private readonly cells: CellState[]
  private readonly tentsInRow: Int32Array
  private readonly tentsInCol: Int32Array
  private readonly freeInRow: Int32Array
  private readonly freeInCol: Int32Array
  /** 每棵树相邻的帐篷数 */
  private readonly tentsNearTree: Int32Array
  /** 每棵树相邻的空地数 */
  private readonly freeNearTree: Int32Array
  /** 待决定的空地（row-major 顺序） */
  private readonly order: number[] = []
  private readonly maxNodes: number
  private readonly deadline: number
  nodes = 0
  timedOut = false

  constructor(puzzle: Puzzle, opts: SearchOptions = {}) {
    this.puzzle = puzzle
    this.w = puzzle.width
    this.h = puzzle.height
    this.cells = new Array<CellState>(this.w * this.h).fill(CS.Unknown)
    this.tentsInRow = new Int32Array(this.h)
    this.tentsInCol = new Int32Array(this.w)
    this.freeInRow = new Int32Array(this.h)
    this.freeInCol = new Int32Array(this.w)
    this.tentsNearTree = new Int32Array(this.w * this.h)
    this.freeNearTree = new Int32Array(this.w * this.h)

    for (let cy = 0; cy < this.h; cy++) {
      for (let cx = 0; cx < this.w; cx++) {
        const i = cellIndex(this.w, cx, cy)
        if (puzzle.trees[i]) continue
        this.order.push(i)
        this.freeInRow[cy]!++
        this.freeInCol[cx]!++
        for (const nb of neighbors4(this.w, this.h, cx, cy)) {
          const j = cellIndex(this.w, nb.cx, nb.cy)
          if (puzzle.trees[j]) this.freeNearTree[j]!++
        }
      }
    }

    this.maxNodes = opts.maxNodes ?? 400_000
    this.deadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : 0
  }

  private rowOf(i: number): number {
    return Math.floor(i / this.w)
  }

  private colOf(i: number): number {
    return i % this.w
  }

  /** 放帐篷是否合法（含树/相邻帐篷约束） */
  private canTent(i: number): boolean {
    const cx = this.colOf(i)
    const cy = this.rowOf(i)
    // 恰好挨一棵树
    let trees = 0
    for (const nb of neighbors4(this.w, this.h, cx, cy)) {
      if (this.puzzle.trees[cellIndex(this.w, nb.cx, nb.cy)]) trees++
    }
    // 不能挨上已放帐篷（正交或斜角都不行）
    for (const nb of neighbors8(this.w, this.h, cx, cy)) {
      if (this.cells[cellIndex(this.w, nb.cx, nb.cy)] === CS.Tent) return false
    }
    if (trees !== 1) return false
    // 行/列上限
    const row = this.rowOf(i)
    const col = this.colOf(i)
    const rowClue = this.puzzle.rowClues[row]
    if (rowClue !== null && rowClue !== undefined && this.tentsInRow[row]! + 1 > rowClue) return false
    const colClue = this.puzzle.colClues[col]
    if (colClue !== null && colClue !== undefined && this.tentsInCol[col]! + 1 > colClue) return false
    return true
  }

  private checkBudget(): boolean {
    if (this.nodes > this.maxNodes) {
      this.timedOut = true
      return false
    }
    if (this.deadline && (this.nodes & 2047) === 0 && Date.now() > this.deadline) {
      this.timedOut = true
      return false
    }
    return true
  }

  /** 全局剪枝：每棵树的相邻帐篷还不能超，且还得有机会补到 1 */
  private treesOk(): boolean {
    for (const t of treePositions(this.puzzle)) {
      const near = this.tentsNearTree[t.index]!
      if (near > 1) return false
      if (near === 0 && this.freeNearTree[t.index]! === 0) return false
    }
    return true
  }

  /** 行/列：剩余空地要够把线索补满 */
  private linesOk(): boolean {
    for (let cy = 0; cy < this.h; cy++) {
      const clue = this.puzzle.rowClues[cy]
      if (clue === null || clue === undefined) continue
      if (this.tentsInRow[cy]! + this.freeInRow[cy]! < clue) return false
    }
    for (let cx = 0; cx < this.w; cx++) {
      const clue = this.puzzle.colClues[cx]
      if (clue === null || clue === undefined) continue
      if (this.tentsInCol[cx]! + this.freeInCol[cx]! < clue) return false
    }
    return true
  }

  private apply(i: number, v: CellState): void {
    this.cells[i] = v
    const row = this.rowOf(i)
    const col = this.colOf(i)
    this.freeInRow[row]!--
    this.freeInCol[col]!--
    // 这块地被定下来了，相邻树少一个「可选项」
    const cx = col
    const cy = row
    for (const nb of neighbors4(this.w, this.h, cx, cy)) {
      const j = cellIndex(this.w, nb.cx, nb.cy)
      if (this.puzzle.trees[j]) this.freeNearTree[j]!--
    }
    if (v === CS.Tent) {
      this.tentsInRow[row]!++
      this.tentsInCol[col]!++
      for (const nb of neighbors4(this.w, this.h, cx, cy)) {
        const j = cellIndex(this.w, nb.cx, nb.cy)
        if (this.puzzle.trees[j]) this.tentsNearTree[j]!++
      }
    }
  }

  private undo(i: number, v: CellState): void {
    this.cells[i] = CS.Unknown
    const row = this.rowOf(i)
    const col = this.colOf(i)
    this.freeInRow[row]!++
    this.freeInCol[col]!++
    const cx = col
    const cy = row
    for (const nb of neighbors4(this.w, this.h, cx, cy)) {
      const j = cellIndex(this.w, nb.cx, nb.cy)
      if (this.puzzle.trees[j]) this.freeNearTree[j]!++
    }
    if (v === CS.Tent) {
      this.tentsInRow[row]!--
      this.tentsInCol[col]!--
      for (const nb of neighbors4(this.w, this.h, cx, cy)) {
        const j = cellIndex(this.w, nb.cx, nb.cy)
        if (this.puzzle.trees[j]) this.tentsNearTree[j]!--
      }
    }
  }

  search(onFound: (cells: CellState[]) => boolean): boolean {
    const dfs = (k: number): boolean => {
      if (k === this.order.length) return onFound(this.cells.slice())
      this.nodes++
      if (!this.checkBudget()) return true
      const i = this.order[k]!
      for (const v of [CS.Tent, CS.Grass] as const) {
        if (v === CS.Tent && !this.canTent(i)) continue
        this.apply(i, v)
        if (this.treesOk() && this.linesOk() && dfs(k + 1)) return true
        this.undo(i, v)
      }
      return false
    }
    return dfs(0)
  }

  toState(puzzle: Puzzle, cells: CellState[]): GameState {
    const st = createEmptyState(puzzle)
    for (let i = 0; i < cells.length; i++) st.cells[i] = cells[i]!
    return st
  }
}

/** 统计解的个数（上限 limit） */
export function countSolutions(
  puzzle: Puzzle,
  limit = 2,
  opts: SearchOptions = {},
): CountResult {
  const s = new Searcher(puzzle, opts)
  let count = 0
  let first: GameState | null = null
  let second: GameState | null = null
  s.search((cells) => {
    count++
    if (!first) first = s.toState(puzzle, cells)
    else if (!second) second = s.toState(puzzle, cells)
    return count >= limit
  })
  return { count, capped: count >= limit, nodes: s.nodes, timedOut: s.timedOut, first, second }
}

/** 供生成器使用：非树格子集合 */
export function emptyCells(puzzle: Puzzle): number[] {
  const out: number[] = []
  for (let cy = 0; cy < puzzle.height; cy++) {
    for (let cx = 0; cx < puzzle.width; cx++) {
      const i = cellIndex(puzzle.width, cx, cy)
      if (!puzzle.trees[i]) out.push(i)
    }
  }
  return out
}

export { cellValue }
