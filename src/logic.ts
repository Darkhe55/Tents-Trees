/**
 * 帐篷逻辑解谜器（预留位置）
 * ==========================
 *
 * 这里未来放「人类规则推理」：不枚举解，一步步推必然结论，每步带理由，
 * 由 main.ts 逐条动画播放（也能直接采用整份结论）。
 *
 * 计划实现的规则（往 RULES 里加即可，主循环已就绪）：
 *   1. 线索行/列已满 → 该行/列其余格子全标草地
 *   2. 某棵树四周只剩一个空格 → 那个空格必是帐篷
 *   3. 某格若放帐篷会挨上两个树 / 挨上别的帐篷 → 必是草地
 *   4. 一棵树已有相邻帐篷 → 它周围其余空地全标草地
 *   5. 假设推演（配合 solver 反证）
 */
import type { LogicStep, Puzzle } from './types'
import type { CellState } from './types'

export interface LogicPlan {
  supported: boolean
  reason: string
  steps: LogicStep[]
  complete: boolean
  ms: number
  cells: CellState[]
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

export const RULES: RuleMeta[] = []

export function planLogicSolve(_puzzle: Puzzle): LogicPlan {
  return {
    supported: false,
    reason: '逻辑解谜器尚未实现：已预留 src/logic.ts（返回可播放的推理步骤）。',
    steps: [],
    complete: false,
    ms: 0,
    cells: [],
    conflicts: [],
  }
}
