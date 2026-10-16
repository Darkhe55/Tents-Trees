/**
 * 帐篷（Tents）核心类型
 *
 * 规则：
 * 1. 每棵树恰好配一个正交相邻（上下左右）的帐篷
 * 2. 每个帐篷恰好只挨一棵树
 * 3. 任意两个帐篷不能相邻（正交或斜角都不行）
 * 4. 棋盘外数字 = 对应行/列的帐篷数
 */

/** 格子归属：空地 / 树（树由题面固定，玩家不可改） */
export const enum CellKind {
  Empty = 0,
  Tree = 1,
}

/** 空地状态：未定 / 帐篷 / 草地（玩家标记此处无帐篷） */
export const enum CellState {
  Unknown = 0,
  Tent = 1,
  Grass = 2,
}

export interface Puzzle {
  id: string
  name: string
  width: number
  height: number
  /** row-major，length = W*H，true = 树 */
  trees: boolean[]
  /** 行线索，length = H；null = 无数字 */
  rowClues: Array<number | null>
  /** 列线索，length = W；null = 无数字 */
  colClues: Array<number | null>
  /** 参考解（提示用），row-major length = W*H，true = 帐篷 */
  solution?: boolean[]
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
}

export interface GameState {
  puzzleId: string
  width: number
  height: number
  /** row-major，length = W*H；树格子恒为 Unknown（不可交互） */
  cells: CellState[]
}

export interface Move {
  index: number
  from: CellState
  to: CellState
}

export interface ValidationResult {
  /** 相邻帐篷数不等于 1 的树 */
  badTrees: number[]
  /** 相邻树数不等于 1 的帐篷 */
  badTents: number[]
  /** 与别的帐篷相邻（含斜角）的帐篷 */
  adjacentTents: number[]
  /** 帐篷数不符的行号 */
  badRows: number[]
  /** 帐篷数不符的列号 */
  badCols: number[]
  /** 已决定的空地数 */
  filled: number
  /** 未定的空地数 */
  unknown: number
  solved: boolean
}

/** 逻辑解谜器的一条推理结论 */
export interface LogicStep {
  index: number
  value: CellState
  /** 人类可读的推理依据 */
  reason: string
}
