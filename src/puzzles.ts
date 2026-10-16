import type { Puzzle } from './types'
import { RAW_PUZZLES, type RawPuzzle } from './puzzles-data'

function parseBoolMap(s: string): boolean[] {
  return [...s].map((ch) => ch === '#' || ch === 'o')
}

function parseClues(s: string): Array<number | null> {
  if (!s) return []
  return s.split(',').map((part) => (part === '' ? null : Number(part)))
}

function toPuzzle(r: RawPuzzle): Puzzle {
  return {
    id: r.id,
    name: r.name,
    width: r.width,
    height: r.height,
    difficulty: r.difficulty,
    trees: parseBoolMap(r.trees),
    rowClues: parseClues(r.rows),
    colClues: parseClues(r.cols),
    solution: parseBoolMap(r.solution),
  }
}

/** 静态题库（import 即用，无运行时生成） */
export const puzzles: Puzzle[] = RAW_PUZZLES.map(toPuzzle)

export function getPuzzle(id: string): Puzzle | undefined {
  return puzzles.find((p) => p.id === id)
}

export function randomPuzzle(avoidId?: string): Puzzle {
  const pool = avoidId ? puzzles.filter((p) => p.id !== avoidId) : puzzles
  const list = pool.length ? pool : puzzles
  return list[Math.floor(Math.random() * list.length)]!
}

export function treeCount(p: Puzzle): number {
  return p.trees.filter(Boolean).length
}

export function listSeries(): string[] {
  return [...new Set(RAW_PUZZLES.map((r) => r.series))]
}

export function bySeries(series: string): Puzzle[] {
  return RAW_PUZZLES.filter((r) => r.series === series).map(toPuzzle)
}
