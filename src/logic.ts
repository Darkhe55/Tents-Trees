/**
 * 帐篷逻辑解谜器
 * ==============
 *
 * 不枚举解，只推「人也能看出来」的必然结论，一步步标格子，每步带理由，
 * 由 main.ts 逐条动画播放（也能直接采用整份结论）。
 *
 * 官方语义是「树–帐篷存在完整的一对一配对」：帐篷可以同时挨多棵树，
 * 树也可以同时挨多顶帐篷。因此这里只保留不会误报的推理：
 *   1. 帐篷八邻的空地 → 草地（帐篷互不相邻，斜角也不行）
 *   2. 树没有相邻帐篷、且只剩一个相邻空地 → 那个空地必是帐篷
 *   3. 行列线索已达标 → 该行/列其余空地全标草地
 *   4. 匹配可行性检查：已放帐篷配不上不同的树 / 某棵树已经没有任何可放帐篷
 *      的相邻格 → 盘面已经不可能完成（只报告冲突，不猜格子）
 *
 * 「一棵树旁边有两顶帐篷」「一顶帐篷旁边有两棵树」都**不是**冲突：
 * 只要还存在完整配对就行，所以不再据此标红或报错。
 *
 * 前三条规则都是「必然结论」：只根据已确定的格子推导，不做假设，
 * 所以推出来的每一格都一定是对的（前提是玩家自己标的格子没错）。
 */
import type { CellState, LogicStep, Puzzle } from './types'
import { CellState as CS } from './types'
import { cellIndex, neighbors4, neighbors8, treePositions } from './state'
import { adjacentTrees, maximumMatching } from './matching'

export interface LogicPlan {
  supported: boolean
  reason: string
  steps: LogicStep[]
  /** 所有可放格子都已定下来 */
  complete: boolean
  ms: number
  /** 推完后的棋盘（保留玩家原有标记） */
  cells: CellState[]
  /** 当前盘面与规则矛盾之处 */
  conflicts: string[]
}

export interface RuleCtx {
  puzzle: Puzzle
  cells: CellState[]
  conflicts: string[]
}

export type RuleFn = (ctx: RuleCtx) => LogicStep[]

export interface RuleMeta {
  id: string
  name: string
  fn: RuleFn
}

/* ———————————————————— 规则 1 ———————————————————— */

/** 帐篷八邻的空地 → 草地 */
const ruleTentSurround: RuleFn = ({ puzzle, cells }) => {
  const steps: LogicStep[] = []
  const w = puzzle.width
  const h = puzzle.height
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      if (cells[cellIndex(w, cx, cy)] !== CS.Tent) continue
      for (const nb of neighbors8(w, h, cx, cy)) {
        const j = cellIndex(w, nb.cx, nb.cy)
        if (puzzle.trees[j] || cells[j] !== CS.Unknown) continue
        cells[j] = CS.Grass
        steps.push({ index: j, value: CS.Grass, reason: '挨着帐篷，不能再放帐篷' })
      }
    }
  }
  return steps
}

/* ———————————————————— 规则 2 ———————————————————— */

/**
 * 树没有相邻帐篷、且只剩一个相邻空地 → 该空地必是帐篷。
 * 注意：树旁边已经有一顶帐篷时不再推任何东西（这顶帐篷可能被别的树占用，
 * 但树本身也可以再等另一顶帐篷），所以旧版「相邻帐篷数 > 1 即冲突」被删掉了。
 */
const ruleLoneTree: RuleFn = ({ puzzle, cells }) => {
  const steps: LogicStep[] = []
  const w = puzzle.width
  const h = puzzle.height
  for (const t of treePositions(puzzle)) {
    const unknown: number[] = []
    let tents = 0
    for (const nb of neighbors4(w, h, t.cx, t.cy)) {
      const j = cellIndex(w, nb.cx, nb.cy)
      if (puzzle.trees[j]) continue
      const v = cells[j]!
      if (v === CS.Tent) tents++
      else if (v === CS.Unknown) unknown.push(j)
    }
    // 已经挨着帐篷的树可能由其中一顶配到，不强行推断
    if (tents > 0) continue
    if (unknown.length === 1) {
      const j = unknown[0]!
      cells[j] = CS.Tent
      steps.push({ index: j, value: CS.Tent, reason: '这棵树没有帐篷，且只剩一个能放帐篷的相邻格' })
    }
  }
  return steps
}

/* ———————————————————— 规则 3 ———————————————————— */

/** 行列线索已达标 → 其余空地全标草地 */
const ruleLineFull: RuleFn = ({ puzzle, cells, conflicts }) => {
  const steps: LogicStep[] = []
  const w = puzzle.width
  const h = puzzle.height

  const scan = (clue: number | null | undefined, indices: number[], label: string) => {
    // 自定义题板的线索可以是 null，没有数字就无从判断
    if (clue === null || clue === undefined) return
    let tents = 0
    const unknown: number[] = []
    for (const j of indices) {
      if (puzzle.trees[j]) continue
      const v = cells[j]!
      if (v === CS.Tent) tents++
      else if (v === CS.Unknown) unknown.push(j)
    }
    if (tents > clue) {
      conflicts.push(`${label}放了 ${tents} 顶帐篷，超过线索 ${clue}`)
      return
    }
    if (tents === clue) {
      for (const j of unknown) {
        cells[j] = CS.Grass
        steps.push({ index: j, value: CS.Grass, reason: `${label}的帐篷数已经够了` })
      }
    }
  }

  for (let cy = 0; cy < h; cy++) {
    const indices: number[] = []
    for (let cx = 0; cx < w; cx++) indices.push(cellIndex(w, cx, cy))
    scan(puzzle.rowClues[cy], indices, `第 ${cy + 1} 行`)
  }
  for (let cx = 0; cx < w; cx++) {
    const indices: number[] = []
    for (let cy = 0; cy < h; cy++) indices.push(cellIndex(w, cx, cy))
    scan(puzzle.colClues[cx], indices, `第 ${cx + 1} 列`)
  }
  return steps
}

/* ———————————————————— 规则 4 ———————————————————— */

/**
 * 匹配可行性检查（只报冲突，不猜格子）：
 *  - 每顶已放帐篷要能配到一棵不同的树；
 *  - 每棵树要能分到一格格子（已放帐篷或未定空地）。
 * 任意一条不成立，盘面都不可能在匹配语义下完成。
 */
const ruleMatching: RuleFn = ({ puzzle, cells, conflicts }) => {
  const w = puzzle.width
  const h = puzzle.height

  const tents: number[] = []
  for (let i = 0; i < w * h; i++) {
    if (puzzle.trees[i]) continue
    if (cells[i] === CS.Tent) tents.push(i)
  }
  const tentAdj = tents.map((index) => adjacentTrees(puzzle, index))
  const tentMatch = maximumMatching(tentAdj, w * h)
  if (tentMatch.size !== tents.length) {
    const unmatched = tents.filter((_, k) => tentMatch.leftMatch[k]! === -1)
    const first = unmatched[0]
    if (first !== undefined) {
      const cx = (first % w) + 1
      const cy = Math.floor(first / w) + 1
      conflicts.push(`第 ${cy} 行第 ${cx} 列的帐篷已经无法和别的帐篷各自配上不同的树`)
    }
  }

  const trees = treePositions(puzzle)
  const treeAdj = trees.map((t) => {
    const out: number[] = []
    for (const nb of neighbors4(w, h, t.cx, t.cy)) {
      const j = cellIndex(w, nb.cx, nb.cy)
      if (puzzle.trees[j]) continue
      const v = cells[j]
      if (v === CS.Tent || v === CS.Unknown) out.push(j)
    }
    return out
  })
  const treeMatch = maximumMatching(treeAdj, w * h)
  if (treeMatch.size !== trees.length) {
    const k = treeMatch.leftMatch.findIndex((v) => v === -1)
    const t = k >= 0 ? trees[k] : undefined
    if (t) {
      conflicts.push(`第 ${t.cy + 1} 行第 ${t.cx + 1} 列的树已经没有任何能放帐篷的相邻格`)
    }
  }

  return []
}

export const RULES: RuleMeta[] = [
  { id: 'tent-surround', name: '帐篷周围 → 草地', fn: ruleTentSurround },
  { id: 'lone-tree', name: '树只剩一个相邻格 → 帐篷', fn: ruleLoneTree },
  { id: 'line-full', name: '行列线索达标 → 草地', fn: ruleLineFull },
]

/* ———————————————————— 主循环 ———————————————————— */

/** 反复跑规则到不动点；steps 按推出顺序收集 */
function infer(puzzle: Puzzle, start: CellState[]) {
  const cells = start.slice()
  const steps: LogicStep[] = []
  const conflicts: string[] = []
  const ctx: RuleCtx = { puzzle, cells, conflicts }
  // 每轮至少定下一格，所以轮数上限就是格子数
  const maxRounds = puzzle.width * puzzle.height + 1

  for (let round = 0; round < maxRounds; round++) {
    let progressed = false
    for (const rule of RULES) {
      const produced = rule.fn(ctx)
      if (produced.length) {
        steps.push(...produced)
        progressed = true
      }
    }
    if (!progressed) break
  }

  // 推到不动点后再做一次匹配可行性检查（只报冲突，不产生步骤）
  ruleMatching(ctx)

  // 同一句冲突会被多轮重复报，去重
  return { cells, steps, conflicts: [...new Set(conflicts)] }
}

/**
 * 从当前盘面推出必然结论。
 * @param start 玩家已标的格子；不传则从空盘开始（等于「直接解」）
 */
export function planLogicSolve(puzzle: Puzzle, start?: CellState[]): LogicPlan {
  const t0 = Date.now()
  const total = puzzle.width * puzzle.height
  const initial =
    start && start.length === total ? start.slice() : new Array<CellState>(total).fill(CS.Unknown)

  const { cells, steps, conflicts } = infer(puzzle, initial)

  const placeable = total - puzzle.trees.filter(Boolean).length
  const decided = cells.reduce((n, v, i) => (puzzle.trees[i] || v === CS.Unknown ? n : n + 1), 0)

  return {
    supported: true,
    reason: '',
    steps,
    complete: decided === placeable,
    ms: Date.now() - t0,
    cells,
    conflicts,
  }
}
