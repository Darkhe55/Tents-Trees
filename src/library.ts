/**
 * 自定义题库：把玩家自己摆的题板存进 localStorage。
 *
 * 存储形态沿用 puzzles-data.ts 的字符串编码：'#' / 'o' 表示树，'.' 表示空地，
 * 一个题板编码为长度 W*H 的字符串，省空间也方便肉眼检查。
 */

import type { Puzzle } from './types'

const KEY = 'tents-saved-puzzles'

export type SavedPuzzle = Puzzle & {
  savedAt: number
}

function parseTrees(s: string): boolean[] {
  return [...s].map((ch) => ch === '#' || ch === 'o')
}

function encodeTrees(trees: boolean[]): string {
  return trees.map((t) => (t ? '#' : '.')).join('')
}

export function loadSavedPuzzles(): SavedPuzzle[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as Array<{
      id: string
      name: string
      width: number
      height: number
      trees: string
      savedAt?: number
    }>
    return arr
      .filter(
        (x) =>
          x &&
          x.id &&
          x.width > 0 &&
          x.height > 0 &&
          typeof x.trees === 'string' &&
          x.trees.length === x.width * x.height,
      )
      .map((x) => ({
        id: x.id,
        name: x.name || `自定义 · ${x.width}×${x.height}`,
        width: x.width,
        height: x.height,
        difficulty: 'custom' as const,
        trees: parseTrees(x.trees),
        // 行/列线索留空：自定义题不给线索，由玩家自行推理
        rowClues: new Array<number | null>(x.height).fill(null),
        colClues: new Array<number | null>(x.width).fill(null),
        savedAt: typeof x.savedAt === 'number' ? x.savedAt : Date.now(),
      }))
  } catch {
    return []
  }
}

function persistSavedPuzzles(list: SavedPuzzle[]): void {
  const payload = list.map((p) => ({
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    trees: encodeTrees(p.trees),
    savedAt: p.savedAt,
  }))
  localStorage.setItem(KEY, JSON.stringify(payload))
}

/** 追加或覆盖同 id，返回最新列表 */
export function savePuzzleToLibrary(p: Puzzle): SavedPuzzle[] {
  const list = loadSavedPuzzles()
  const item: SavedPuzzle = { ...p, difficulty: 'custom', savedAt: Date.now() }
  const i = list.findIndex((x) => x.id === p.id)
  if (i >= 0) list[i] = item
  else list.push(item)
  persistSavedPuzzles(list)
  return list
}

export function removeSavedPuzzle(id: string): SavedPuzzle[] {
  const list = loadSavedPuzzles().filter((p) => p.id !== id)
  persistSavedPuzzles(list)
  return list
}
