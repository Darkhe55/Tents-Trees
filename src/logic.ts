/**
 * 帐篷逻辑解谜器
 * ==============
 *
 * 不枚举解，只推「人也能看出来」的必然结论，一步步标格子，每步带理由，
 * 由 main.ts 逐条动画播放（也能直接采用整份结论）。
 *
 * 规则（往 RULES 里加即可，主循环反复跑到不动点）：
 *   1. 帐篷八邻的空地 → 草地（帐篷互不相邻，斜角也不行）
 *   2. 树只剩一个相邻空地、且还没有相邻帐篷 → 那个空地必是帐篷
 *   3. 行列线索已达标 → 该行/列其余空地全标草地
 *
 * 三条规则都是「必然结论」：只根据已确定的格子推导，不做假设，
 * 所以推出来的每一格都一定是对的（前提是玩家自己标的格子没错）。
 */
import type { CellState, LogicStep, Puzzle } from './types'
import { CellState as CS } from './types'
import { cellIndex, neighbors4, neighbors8, treePositions } from './state'

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

/** 树只剩一个相邻空地、且还没有相邻帐篷 → 该空地必是帐篷 */
const ruleLoneTree: RuleFn = ({ puzzle, cells, conflicts }) => {
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
    if (tents > 1) {
      conflicts.push(`第 ${t.cy + 1} 行第 ${t.cx + 1} 列的树挨了 ${tents} 顶帐篷`)
      continue
    }
    if (tents === 0 && unknown.length === 1) {
      const j = unknown[0]!
      cells[j] = CS.Tent
      steps.push({ index: j, value: CS.Tent, reason: '这棵树只剩一个能放帐篷的相邻格' })
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
