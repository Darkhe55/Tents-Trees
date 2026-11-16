/**
 * 帐篷求解器（树 → 帐篷配对搜索 + 剪枝），用于题库唯一解校验与识图导入。
 *
 * 语义：树–帐篷是二分图配对（一顶帐篷可以挨多棵树，一棵树也可以挨多顶帐篷，
 * 只要存在完整的一一配对）。因此搜索按「给每棵树指派一顶相邻帐篷」进行：
 * 每个解对应一组帐篷摆法；同一组摆法若有多种配对方式，按摆法去重，只算一个解。
 *
 * 剪枝：
 *  - 每棵树只能分到一顶自己的帐篷，格子不能复用；帐篷之间不能相邻（含斜角）；
 *  - 行/列：已放帐篷数 ≤ 线索；线索齐全时行/列合计必须等于树数；
 *  - 单候选强制：某棵还没分到帐篷的树只剩一个可放格子 → 该格必是帐篷；
 *  - 剩余树的候选格必须能一一分配（二分图最大匹配饱和所有未分配树）；
 *  - 行/列剩余缺口不能超过「还有树能放进去的可用格」数。
 */
import { cellIndex, createEmptyState, neighbors4, neighbors8 } from './state'
import { maximumMatching } from './matching'
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

/** 汇总行/列线索；null = 该行/列没有数字 */
function clueTotals(clues: ReadonlyArray<number | null>): { sum: number; hasNull: boolean } {
  let sum = 0
  let hasNull = false
  for (const clue of clues) {
    if (clue === null || clue === undefined) hasNull = true
    else sum += clue
  }
  return { sum, hasNull }
}

class Searcher {
  readonly w: number
  readonly h: number
  private readonly total: number
  private readonly puzzle: Puzzle
  private readonly deadline: number
  private readonly maxNodes: number

  /** 所有树格索引，ordinal = 数组下标 */
  private readonly treeCells: number[]
  /** 每棵树正交相邻的空地格索引 */
  private readonly treeAdj: number[][]
  /** 每个格子正交相邻的树 ordinal */
  private readonly treeOrdsByCell: number[][]
  private readonly treeCount: number

  /** 树 ordinal → 已分到的帐篷格（-1 = 未分） */
  private readonly treeTent: Int32Array
  /** 格子 → 是否已作为某棵树的帐篷 */
  private readonly isTent: Uint8Array
  private readonly tentsInRow: Int32Array
  private readonly tentsInCol: Int32Array
  private assignedCount = 0

  /** 已找到的帐篷摆法（去重用）：key = 帐篷格索引升序拼接 */
  private readonly seenSolutions = new Set<string>()
  /** 赋值回滚栈：flat [tree, cell, tree, cell, …] */
  private readonly trail: number[] = []

  nodes = 0
  timedOut = false

  constructor(puzzle: Puzzle, opts: SearchOptions = {}) {
    this.puzzle = puzzle
    this.w = puzzle.width
    this.h = puzzle.height
    this.total = this.w * this.h
    this.maxNodes = opts.maxNodes ?? 400_000
    this.deadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : 0

    this.treeCells = []
    this.treeOrdsByCell = new Array<number[]>(this.total)
    for (let i = 0; i < this.total; i++) this.treeOrdsByCell[i] = []
    for (let i = 0; i < this.total; i++) {
      if (!puzzle.trees[i]) continue
      const ordinal = this.treeCells.length
      this.treeCells.push(i)
      const cx = i % this.w
      const cy = Math.floor(i / this.w)
      for (const nb of neighbors4(this.w, this.h, cx, cy)) {
        const j = cellIndex(this.w, nb.cx, nb.cy)
        if (!puzzle.trees[j]) this.treeOrdsByCell[j]!.push(ordinal)
      }
    }
    this.treeCount = this.treeCells.length

    this.treeAdj = this.treeCells.map((index) => {
      const cx = index % this.w
      const cy = Math.floor(index / this.w)
      const out: number[] = []
      for (const nb of neighbors4(this.w, this.h, cx, cy)) {
        const j = cellIndex(this.w, nb.cx, nb.cy)
        if (!puzzle.trees[j]) out.push(j)
      }
      return out
    })

    this.treeTent = new Int32Array(this.treeCount).fill(-1)
    this.isTent = new Uint8Array(this.total)
    this.tentsInRow = new Int32Array(this.h)
    this.tentsInCol = new Int32Array(this.w)
  }

  private rowOf(i: number): number {
    return Math.floor(i / this.w)
  }

  private colOf(i: number): number {
    return i % this.w
  }

  /** 线索全给齐时，行/列合计必须等于树数；否则必然无解 */
  private totalsConsistent(): boolean {
    const rows = clueTotals(this.puzzle.rowClues)
    const cols = clueTotals(this.puzzle.colClues)
    if (rows.sum > this.treeCount) return false
    if (cols.sum > this.treeCount) return false
    if (!rows.hasNull && rows.sum !== this.treeCount) return false
    if (!cols.hasNull && cols.sum !== this.treeCount) return false
    return true
  }

  private rowCapFull(row: number): boolean {
    const clue = this.puzzle.rowClues[row]
    if (clue === null || clue === undefined) return false
    return this.tentsInRow[row]! >= clue
  }

  private colCapFull(col: number): boolean {
    const clue = this.puzzle.colClues[col]
    if (clue === null || clue === undefined) return false
    return this.tentsInCol[col]! >= clue
  }

  /** 格子本身是否还能放帐篷（行/列上限 / 是否已被占用 / 八邻是否已有帐篷） */
  private cellAvailable(i: number): boolean {
    if (this.isTent[i]) return false
    const cx = this.colOf(i)
    const cy = this.rowOf(i)
    if (this.rowCapFull(cy) || this.colCapFull(cx)) return false
    for (const nb of neighbors8(this.w, this.h, cx, cy)) {
      if (this.isTent[cellIndex(this.w, nb.cx, nb.cy)]) return false
    }
    return true
  }

  /** 某棵树当前还能选哪些格子 */
  private candidatesOf(tree: number, out: number[]): number[] {
    out.length = 0
    const adj = this.treeAdj[tree]!
    for (let k = 0; k < adj.length; k++) {
      const cell = adj[k]!
      if (this.cellAvailable(cell)) out.push(cell)
    }
    return out
  }

  private assign(tree: number, cell: number): void {
    this.treeTent[tree] = cell
    this.isTent[cell] = 1
    this.tentsInRow[this.rowOf(cell)]!++
    this.tentsInCol[this.colOf(cell)]!++
    this.assignedCount++
    this.trail.push(tree, cell)
  }

  private removeAssignment(tree: number, cell: number): void {
    this.treeTent[tree] = -1
    this.isTent[cell] = 0
    this.tentsInRow[this.rowOf(cell)]!--
    this.tentsInCol[this.colOf(cell)]!--
    this.assignedCount--
  }

  /** 把回滚栈弹到 mark，撤销 mark 之后的所有赋值 */
  private unwind(mark: number): void {
    while (this.trail.length > mark) {
      const cell = this.trail.pop()!
      const tree = this.trail.pop()!
      this.removeAssignment(tree, cell)
    }
  }

  /**
   * 传播到不动点：只剩一个候选的树必须立刻放帐篷。
   * 返回 false = 当前分支已经矛盾。
   */
  private propagate(scratch: number[]): boolean {
    let changed = true
    while (changed) {
      changed = false
      for (let t = 0; t < this.treeCount; t++) {
        if (this.treeTent[t] !== -1) continue
        this.candidatesOf(t, scratch)
        if (scratch.length === 0) {
          return false
        }
        if (scratch.length === 1) {
          this.assign(t, scratch[0]!)
          changed = true
        }
      }
    }
    return true
  }

  /**
   * 剩余未分配的树能否各分到一格（二分图最大匹配）。
   * 同时检查行/列剩余缺口是否还有足够的可用格。
   */
  private restFeasible(scratch: number[]): boolean {
    const adj: number[][] = []
    for (let t = 0; t < this.treeCount; t++) {
      if (this.treeTent[t] !== -1) continue
      this.candidatesOf(t, scratch)
      if (scratch.length === 0) return false
      adj.push(scratch.slice())
    }
    if (adj.length) {
      const match = maximumMatching(adj, this.total)
      if (match.size !== adj.length) {
        return false
      }
    }

    // 行列缺口：这一行/列还必须放多少个帐篷，是否还有足够的可用候选格
    const rowCells = new Int32Array(this.h)
    const colCells = new Int32Array(this.w)
    for (let t = 0; t < this.treeCount; t++) {
      if (this.treeTent[t] !== -1) continue
      const adjT = this.treeAdj[t]!
      for (let k = 0; k < adjT.length; k++) {
        const cell = adjT[k]!
        if (!this.cellAvailable(cell)) continue
        rowCells[this.rowOf(cell)]!++
        colCells[this.colOf(cell)]!++
      }
    }
    for (let r = 0; r < this.h; r++) {
      const clue = this.puzzle.rowClues[r]
      if (clue === null || clue === undefined) continue
      const need = clue - this.tentsInRow[r]!
      if (need < 0 || need > rowCells[r]!) {
        return false
      }
    }
    for (let c = 0; c < this.w; c++) {
      const clue = this.puzzle.colClues[c]
      if (clue === null || clue === undefined) continue
      const need = clue - this.tentsInCol[c]!
      if (need < 0 || need > colCells[c]!) {
        return false
      }
    }
    return true
  }

  /** 完整盘面校验：行列数字必须精确吻合 */
  private linesExact(): boolean {
    for (let r = 0; r < this.h; r++) {
      const clue = this.puzzle.rowClues[r]
      if (clue === null || clue === undefined) continue
      if (this.tentsInRow[r] !== clue) return false
    }
    for (let c = 0; c < this.w; c++) {
      const clue = this.puzzle.colClues[c]
      if (clue === null || clue === undefined) continue
      if (this.tentsInCol[c] !== clue) return false
    }
    return true
  }

  private solutionKey(): string {
    const parts: string[] = []
    for (let i = 0; i < this.total; i++) if (this.isTent[i]) parts.push(String(i))
    return parts.join(',')
  }

  private cellsToState(cells: CellState[]): GameState {
    for (let i = 0; i < this.total; i++) {
      if (this.puzzle.trees[i]) continue
      cells[i] = this.isTent[i] ? CS.Tent : CS.Grass
    }
    const st = createEmptyState(this.puzzle)
    st.cells = cells.slice()
    return st
  }

  private checkBudget(): boolean {
    if (this.nodes > this.maxNodes) {
      this.timedOut = true
      return false
    }
    if (this.deadline && (this.nodes & 1023) === 0 && Date.now() > this.deadline) {
      this.timedOut = true
      return false
    }
    return true
  }

  search(onFound: (state: GameState) => boolean): boolean {
    if (!this.totalsConsistent()) return false
    const scratch: number[] = []
    const leafCells: CellState[] = new Array<CellState>(this.total).fill(CS.Unknown)

    const dfs = (): boolean => {
      this.nodes++
      if (!this.checkBudget()) return true
      const mark = this.trail.length
      if (!this.propagate(scratch)) {
        this.unwind(mark)
        return false
      }
      if (this.assignedCount === this.treeCount) {
        if (!this.linesExact()) {
          this.unwind(mark)
          return false
        }
        const key = this.solutionKey()
        let stop = false
        if (!this.seenSolutions.has(key)) {
          this.seenSolutions.add(key)
          stop = onFound(this.cellsToState(leafCells))
        }
        this.unwind(mark)
        return stop
      }
      if (!this.restFeasible(scratch)) {
        this.unwind(mark)
        return false
      }

      // MRV：选候选最少的未分配树
      let bestTree = -1
      let bestCand: number[] = []
      let bestLen = Infinity
      for (let t = 0; t < this.treeCount; t++) {
        if (this.treeTent[t] !== -1) continue
        this.candidatesOf(t, scratch)
        if (scratch.length === 0) {
          this.unwind(mark)
          return false
        }
        if (scratch.length < bestLen) {
          bestLen = scratch.length
          bestTree = t
          bestCand = scratch.slice()
        }
      }
      if (bestTree < 0) {
        this.unwind(mark)
        return false
      }

      // 候选排序：优先「能顺带压掉更多其它树候选」的格子，其次看行列缺口
      const scored = bestCand.map((cell) => {
        let pressure = 0
        for (const ord of this.treeOrdsByCell[cell]!) {
          if (this.treeTent[ord] === -1) pressure++
        }
        return { cell, score: pressure * 8 + this.rowNeed(cell) + this.colNeed(cell) }
      })
      scored.sort((a, b) => b.score - a.score)

      for (const { cell } of scored) {
        if (!this.cellAvailable(cell)) continue
        const branchMark = this.trail.length
        this.assign(bestTree, cell)
        const stop = dfs()
        this.unwind(branchMark)
        if (stop) {
          this.unwind(mark)
          return true
        }
      }
      this.unwind(mark)
      return false
    }

    return dfs()
  }

  private rowNeed(cell: number): number {
    const clue = this.puzzle.rowClues[this.rowOf(cell)]
    if (clue === null || clue === undefined) return 0
    return Math.max(0, clue - this.tentsInRow[this.rowOf(cell)]!)
  }

  private colNeed(cell: number): number {
    const clue = this.puzzle.colClues[this.colOf(cell)]
    if (clue === null || clue === undefined) return 0
    return Math.max(0, clue - this.tentsInCol[this.colOf(cell)]!)
  }

  toState(puzzle: Puzzle, cells: CellState[]): GameState {
    const st = createEmptyState(puzzle)
    for (let i = 0; i < cells.length; i++) st.cells[i] = cells[i]!
    return st
  }
}

/** 统计解的个数（按帐篷摆法去重，上限 limit） */
export function countSolutions(
  puzzle: Puzzle,
  limit = 2,
  opts: SearchOptions = {},
): CountResult {
  const s = new Searcher(puzzle, opts)
  let count = 0
  let first: GameState | null = null
  let second: GameState | null = null
  s.search((state) => {
    count++
    if (!first) first = state
    else if (!second) second = state
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
