import type { CellState, GameState, Move, Puzzle } from './types'
import { CellKind as CK, CellState as CS } from './types'

/* ———————————————————— 索引与邻格 ———————————————————— */

export function cellIndex(w: number, cx: number, cy: number): number {
  return cy * w + cx
}

export function inBoard(w: number, h: number, cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < w && cy < h
}

/** 四邻（正交） */
export function neighbors4(w: number, h: number, cx: number, cy: number) {
  const out: Array<{ cx: number; cy: number }> = []
  if (cx > 0) out.push({ cx: cx - 1, cy })
  if (cx < w - 1) out.push({ cx: cx + 1, cy })
  if (cy > 0) out.push({ cx, cy: cy - 1 })
  if (cy < h - 1) out.push({ cx, cy: cy + 1 })
  return out
}

export function isTree(puzzle: Puzzle, index: number): boolean {
  return puzzle.trees[index] === true
}

export function treePositions(puzzle: Puzzle) {
  const out: Array<{ cx: number; cy: number; index: number }> = []
  for (let cy = 0; cy < puzzle.height; cy++) {
    for (let cx = 0; cx < puzzle.width; cx++) {
      const index = cellIndex(puzzle.width, cx, cy)
      if (puzzle.trees[index]) out.push({ cx, cy, index })
    }
  }
  return out
}

/* ———————————————————— 状态读写 ———————————————————— */

export function createEmptyState(puzzle: Puzzle): GameState {
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    cells: new Array<CellState>(puzzle.width * puzzle.height).fill(CS.Unknown),
  }
}

export function cellValue(state: GameState, index: number): CellState {
  return state.cells[index] ?? CS.Unknown
}

export function setCell(state: GameState, index: number, value: CellState): void {
  state.cells[index] = value
}

/** 点击循环：未定 → 帐篷 → 草地 → 未定 */
export function cycleCell(current: CellState, dir: 1 | -1 = 1): CellState {
  if (current === CS.Unknown) return dir === 1 ? CS.Tent : CS.Grass
  if (current === CS.Tent) return dir === 1 ? CS.Grass : CS.Unknown
  return dir === 1 ? CS.Unknown : CS.Tent
}

export function applyMove(state: GameState, move: Move): void {
  setCell(state, move.index, move.to)
}

export function invertMove(move: Move): Move {
  return { ...move, from: move.to, to: move.from }
}

export function cloneState(state: GameState): GameState {
  return {
    puzzleId: state.puzzleId,
    width: state.width,
    height: state.height,
    cells: state.cells.slice(),
  }
}

/* ———————————————————— 存档 ———————————————————— */

export function serializeState(state: GameState) {
  return {
    version: 1 as const,
    puzzleId: state.puzzleId,
    width: state.width,
    height: state.height,
    cells: state.cells.map((c) => c as number),
    updatedAt: Date.now(),
  }
}

export function deserializeState(data: {
  version: number
  puzzleId: string
  width: number
  height: number
  cells: number[]
}): GameState {
  return {
    puzzleId: data.puzzleId,
    width: data.width,
    height: data.height,
    cells: data.cells.map((n) => n as CellState),
  }
}

/** 由参考解（帐篷布尔数组）构造 GameState */
export function stateFromSolution(puzzle: Puzzle, tents: boolean[]): GameState {
  const st = createEmptyState(puzzle)
  for (let i = 0; i < tents.length; i++) {
    st.cells[i] = tents[i] ? CS.Tent : CS.Grass
  }
  return st
}

export { CK }
