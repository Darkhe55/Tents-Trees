import type { GameState, Puzzle, ValidationResult } from './types'
import { CellState as CS } from './types'
import { cellIndex, cellValue } from './state'

/** 10×10 基准格距；所有描边/字号按此比例缩放 */
export const BASE_CELL = 48

export interface BoardMetrics {
  cell: number
  /** 顶部留白（放列线索） */
  padTop: number
  /** 左侧留白（放行线索） */
  padLeft: number
  padRight: number
  padBottom: number
  width: number
  height: number
  svgWidth: number
  svgHeight: number
  k: number
}

export function metricsFor(puzzle: Puzzle): BoardMetrics {
  const cell = BASE_CELL
  const padTop = cell * 0.78
  const padLeft = cell * 0.78
  const padRight = cell * 0.2
  const padBottom = cell * 0.2
  return {
    cell,
    padTop,
    padLeft,
    padRight,
    padBottom,
    width: puzzle.width,
    height: puzzle.height,
    svgWidth: padLeft + puzzle.width * cell + padRight,
    svgHeight: padTop + puzzle.height * cell + padBottom,
    k: cell / BASE_CELL,
  }
}

/** 格子左上角像素坐标 */
export function cellXY(m: BoardMetrics, cx: number, cy: number) {
  return { x: m.padLeft + cx * m.cell, y: m.padTop + cy * m.cell }
}

/** 格子中心像素坐标 */
export function cellCenter(m: BoardMetrics, cx: number, cy: number) {
  return { x: m.padLeft + (cx + 0.5) * m.cell, y: m.padTop + (cy + 0.5) * m.cell }
}

export function clientToViewBox(svg: SVGSVGElement, clientX: number, clientY: number) {
  const ctm = svg.getScreenCTM()
  if (!ctm) return null
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const p = pt.matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}

/** viewBox 坐标 → 格子索引；越界返回 null */
export function hitTestCell(m: BoardMetrics, puzzle: Puzzle, x: number, y: number): number | null {
  const cx = Math.floor((x - m.padLeft) / m.cell)
  const cy = Math.floor((y - m.padTop) / m.cell)
  if (cx < 0 || cy < 0 || cx >= puzzle.width || cy >= puzzle.height) return null
  return cellIndex(puzzle.width, cx, cy)
}

/** 树图标 */
function treeMarkup(m: BoardMetrics, x: number, y: number): string {
  const c = m.cell
  const cx = x + c * 0.5
  const cy = y + c * 0.42
  return `<g class="tree">
    <rect class="trunk" x="${(cx - c * 0.045).toFixed(2)}" y="${(y + c * 0.56).toFixed(2)}" width="${(c * 0.09).toFixed(2)}" height="${(c * 0.24).toFixed(2)}" rx="${(c * 0.03).toFixed(2)}" />
    <circle class="canopy" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(c * 0.23).toFixed(2)}" />
  </g>`
}

/** 帐篷图标（三角形 + 门） */
function tentMarkup(m: BoardMetrics, x: number, y: number, cell: number): string {
  const c = m.cell
  const x1 = x + c * 0.2
  const x2 = x + c * 0.8
  const xm = x + c * 0.5
  const yTop = y + c * 0.22
  const yBot = y + c * 0.78
  return `<g class="tent" data-cell="${cell}">
    <polygon class="body" points="${x1.toFixed(2)},${yBot.toFixed(2)} ${xm.toFixed(2)},${yTop.toFixed(2)} ${x2.toFixed(2)},${yBot.toFixed(2)}" />
    <polygon class="door" points="${(xm - c * 0.09).toFixed(2)},${yBot.toFixed(2)} ${xm.toFixed(2)},${(y + c * 0.5).toFixed(2)} ${(xm + c * 0.09).toFixed(2)},${yBot.toFixed(2)}" />
  </g>`
}

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
): string {
  const m = metricsFor(puzzle)
  const w = puzzle.width
  const h = puzzle.height

  const badCellSet = new Set<number>([
    ...result.badTrees,
    ...result.badTents,
    ...result.adjacentTents,
  ])
  const badRowSet = new Set(result.badRows)
  const badColSet = new Set(result.badCols)

  const numSize = 17 * m.k
  const inset = 1.5 * m.k

  const parts: string[] = []
  parts.push(
    `<svg class="board-svg" viewBox="0 0 ${m.svgWidth} ${m.svgHeight}" width="${m.svgWidth}" height="${m.svgHeight}" xmlns="http://www.w3.org/2000/svg">`,
  )

  // 格子底
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const { x, y } = cellXY(m, cx, cy)
      parts.push(
        `<rect class="cell" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${m.cell}" height="${m.cell}" />`,
      )
    }
  }

  // 悬停层
  parts.push('<g class="hover-layer"></g>')

  // 错误格高亮（画在图标下面）
  for (const index of badCellSet) {
    const cx = index % w
    const cy = Math.floor(index / w)
    const { x, y } = cellXY(m, cx, cy)
    parts.push(
      `<rect class="cell-error" x="${(x + inset).toFixed(2)}" y="${(y + inset).toFixed(2)}" width="${(m.cell - inset * 2).toFixed(2)}" height="${(m.cell - inset * 2).toFixed(2)}" rx="${6 * m.k}" />`,
    )
  }

  // 演示高亮层
  parts.push('<g class="flash-layer"></g>')

  // 树 / 帐篷 / 草地
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const index = cellIndex(w, cx, cy)
      const { x, y } = cellXY(m, cx, cy)
      if (puzzle.trees[index]) {
        parts.push(treeMarkup(m, x, y))
        continue
      }
      const v = cellValue(state, index)
      if (v === CS.Tent) parts.push(tentMarkup(m, x, y, index))
      else if (v === CS.Grass) {
        const { x: ccx, y: ccy } = cellCenter(m, cx, cy)
        parts.push(
          `<circle class="grass" data-cell="${index}" cx="${ccx.toFixed(2)}" cy="${ccy.toFixed(2)}" r="${(m.cell * 0.075).toFixed(2)}" />`,
        )
      }
    }
  }

  // 行线索（左侧）
  for (let cy = 0; cy < h; cy++) {
    const clue = puzzle.rowClues[cy]
    if (clue === null || clue === undefined) continue
    const { x, y } = cellCenter(m, 0, cy)
    const cls = badRowSet.has(cy) ? 'clue bad' : 'clue'
    parts.push(
      `<text class="${cls}" x="${(x - m.cell * 0.42).toFixed(2)}" y="${y.toFixed(2)}" style="font-size:${numSize}px">${clue}</text>`,
    )
  }

  // 列线索（顶部）
  for (let cx = 0; cx < w; cx++) {
    const clue = puzzle.colClues[cx]
    if (clue === null || clue === undefined) continue
    const { x, y } = cellCenter(m, cx, 0)
    const cls = badColSet.has(cx) ? 'clue bad' : 'clue'
    parts.push(
      `<text class="${cls}" x="${x.toFixed(2)}" y="${(y - m.cell * 0.42).toFixed(2)}" style="font-size:${numSize}px">${clue}</text>`,
    )
  }

  parts.push('</svg>')
  return parts.join('\n')
}

/* ———————————————————— 悬停 / 演示高亮 ———————————————————— */

export function hoverMarkup(m: BoardMetrics, cell: number | null): string {
  if (cell === null) return ''
  const cx = cell % m.width
  const cy = Math.floor(cell / m.width)
  const { x, y } = cellXY(m, cx, cy)
  const inset = 1.5 * m.k
  return `<rect class="cell-hover" x="${(x + inset).toFixed(2)}" y="${(y + inset).toFixed(2)}" width="${(m.cell - inset * 2).toFixed(2)}" height="${(m.cell - inset * 2).toFixed(2)}" rx="${6 * m.k}" />`
}

export function updateHover(svg: SVGSVGElement, m: BoardMetrics, cell: number | null): void {
  const layer = svg.querySelector('.hover-layer')
  if (!layer) return
  layer.innerHTML = hoverMarkup(m, cell)
}

export function flashMarkup(m: BoardMetrics, cell: number | null): string {
  if (cell === null) return ''
  const cx = cell % m.width
  const cy = Math.floor(cell / m.width)
  const { x, y } = cellXY(m, cx, cy)
  const inset = 1 * m.k
  return `<rect class="cell-flash" x="${(x + inset).toFixed(2)}" y="${(y + inset).toFixed(2)}" width="${(m.cell - inset * 2).toFixed(2)}" height="${(m.cell - inset * 2).toFixed(2)}" rx="${6 * m.k}" />`
}

export function updateFlash(svg: SVGSVGElement, m: BoardMetrics, cell: number | null): void {
  const layer = svg.querySelector('.flash-layer')
  if (!layer) return
  layer.innerHTML = flashMarkup(m, cell)
}
