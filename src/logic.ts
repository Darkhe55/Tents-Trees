/**
 * 帐篷逻辑解谜器
 * ==============
 *
 * 不枚举解，只推「人也能看出来」的必然结论，一步步标格子，每步带理由，
 * 由 main.ts 逐条动画播放（也能直接采用整份结论）。
 *
 * 官方语义是「树–帐篷存在完整的一对一配对」：帐篷可以同时挨多棵树，
 * 树也可以同时挨多顶帐篷。因此这里只保留不会误报的推理：
 *
 *   1. 帐篷八邻的空地 → 草地（帐篷互不相邻，斜角也不行）
 *   2. 不挨任何树的空地 → 草地（帐篷必须正交挨一棵树才配得上对）
 *   3. 树只剩唯一可放格 → 帐篷（匹配里这棵树只有一条边）
 *   4. 行列线索已达标 → 该行/列其余空地全标草地（线索饱和）
 *   5. 行列线解法：把一行/列当一排格子做 DP，枚举满足线索和「帐篷不相邻」的
 *      所有摆法；某格在所有摆法里都是帐篷/草地 ⇒ 直接定下来（缺口顶满、
 *      连续段隔一格放帐篷等常用定式都收在这条里）
 *   6. 树的行列归属：某棵树的候选格全在同一行/列 ⇒ 它的帐篷一定在那里；
 *      当这个行/列被这种树占满座位时，该行/列其余空地必是草地
 *   7. 匹配定式：把所有树 ↔ 可放帐篷格建成二分图，求一组覆盖全部树的匹配；
 *      某格在**每一套**完整匹配里都被占用 ⇒ 它必然是帐篷
 *      （Hall 集合约束的具体化）；覆盖不了 ⇒ 报匹配矛盾
 *   8. 相邻两行/列联合线解法：把相邻两行（列）当 2×L 条带做 DP，同时满足
 *      两行线索、行内帐篷不相邻、上下/斜角互斥；补上单行看不到的斜角约束
 *
 * 前六条都是「必然结论」：只根据已确定的格子推导，不做假设，所以推出来的
 * 每一格都一定是对的（前提是玩家自己标的格子没错）。第 7、8 条是对完整
 * 约束的松弛枚举（不是抽样、不是猜测），结论同样必然是正确。
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

/* ———————————————————— 公共小工具 ———————————————————— */

function cellLabel(puzzle: Puzzle, index: number): string {
  const cx = (index % puzzle.width) + 1
  const cy = Math.floor(index / puzzle.width) + 1
  return `第 ${cy} 行第 ${cx} 列`
}

/** 该格至少正交挨着一棵树？帐篷必须这样才配得上对 */
function hasAdjacentTree(puzzle: Puzzle, index: number): boolean {
  return adjacentTrees(puzzle, index).length > 0
}

/** 可放帐篷的未定格：非树、未定、且正交挨着至少一棵树 */
function tentCapable(puzzle: Puzzle, cells: CellState[], index: number): boolean {
  if (puzzle.trees[index]) return false
  if (cells[index] !== CS.Unknown) return false
  return hasAdjacentTree(puzzle, index)
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
 * 不挨任何树的空地 → 草地。
 * 帐篷必须配一棵正交相邻的树，四邻全是空地/边界时这一格永远当不了帐篷。
 * 树格子本身不算（树恒为 Unknown 但不可放帐篷）。
 */
const ruleNoTree: RuleFn = ({ puzzle, cells }) => {
  const steps: LogicStep[] = []
  const total = puzzle.width * puzzle.height
  for (let i = 0; i < total; i++) {
    if (puzzle.trees[i]) continue
    if (cells[i] !== CS.Unknown) continue
    if (hasAdjacentTree(puzzle, i)) continue
    cells[i] = CS.Grass
    steps.push({ index: i, value: CS.Grass, reason: '四周没有树，这一格配不上任何帐篷' })
  }
  return steps
}

/* ———————————————————— 规则 3 ———————————————————— */

/**
 * 树只剩唯一可放格 → 帐篷。
 * 可放格 = 正交相邻、非树、还没被标成草地的格子（未定或已是帐篷）。
 * 只剩一个未定候选时，这棵树要配上帐篷就只能用它。
 */
const ruleLoneTree: RuleFn = ({ puzzle, cells }) => {
  const steps: LogicStep[] = []
  const w = puzzle.width
  const h = puzzle.height
  for (const t of treePositions(puzzle)) {
    const candidates: number[] = []
    for (const nb of neighbors4(w, h, t.cx, t.cy)) {
      const j = cellIndex(w, nb.cx, nb.cy)
      if (puzzle.trees[j]) continue
      const v = cells[j]!
      if (v === CS.Unknown || v === CS.Tent) candidates.push(j)
    }
    if (candidates.length !== 1) continue
    const j = candidates[0]!
    if (cells[j] !== CS.Unknown) continue
    cells[j] = CS.Tent
    steps.push({ index: j, value: CS.Tent, reason: '这棵树只剩这一个能放帐篷的相邻格' })
  }
  return steps
}

/* ———————————————————— 规则 4 ———————————————————— */

/** 行列线索已达标 → 其余空地全标草地；超员报冲突 */
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

/* ———————————————————— 规则 5 ———————————————————— */

/**
 * 行列线解法（标准「Nonogram 式」线推理）：
 * 把一行（列）当成一排格子做动态规划枚举所有满足
 *   - 该行线索的帐篷数、
 *   - 帐篷不左右相邻（列里是不上下相邻）、
 *   - 已确定的帐篷必放、草地/树/不挨树的空格必不放
 * 的摆法。若某未定格在所有摆法里都必须是帐篷 ⇒ 帐篷；都必须是草地 ⇒ 草地；
 * 一种摆法都没有 ⇒ 这一行/列已经和线索矛盾。
 *
 * 只用到本行自身的信息（斜角互斥不在这里考虑），所以每一条结论都安全；
 * 「缺口顶满」「连续段隔一格放」这些常用定式都统一收在同一条规则里。
 */
function lineSolvable(
  puzzle: Puzzle,
  cells: CellState[],
  line: number[],
  clue: number,
  forceIndex: number,
  forceTent: boolean,
): boolean {
  const maxC = Math.max(0, clue)
  let cur = new Uint8Array((maxC + 1) * 2)
  cur[0] = 1
  for (let i = 0; i < line.length; i++) {
    const j = line[i]!
    const kind = ((): 0 | 1 | 2 => {
      if (i === forceIndex) return forceTent ? 1 : 0
      if (puzzle.trees[j]) return 0
      const v = cells[j]!
      if (v === CS.Tent) return 1
      if (v === CS.Grass) return 0
      return tentCapable(puzzle, cells, j) ? 2 : 0
    })()
    const next = new Uint8Array((maxC + 1) * 2)
    for (let c = 0; c <= maxC; c++) {
      for (let prev = 0; prev <= 1; prev++) {
        if (!cur[c * 2 + prev]) continue
        if (kind !== 1) next[c * 2] = 1
        if (kind !== 0 && !prev && c + 1 <= maxC) next[(c + 1) * 2 + 1] = 1
      }
    }
    cur = next
  }
  return cur[maxC * 2] === 1 || cur[maxC * 2 + 1] === 1
}

const ruleLineSolve: RuleFn = ({ puzzle, cells, conflicts }) => {
  const steps: LogicStep[] = []
  const w = puzzle.width
  const h = puzzle.height

  const apply = (clue: number | null | undefined, line: number[], label: string) => {
    if (clue === null || clue === undefined) return
    if (!lineSolvable(puzzle, cells, line, clue, -1, false)) {
      conflicts.push(`${label}的线索 ${clue} 和已确定的格子矛盾，放不下这么多帐篷`)
      return
    }
    for (let i = 0; i < line.length; i++) {
      const j = line[i]!
      if (puzzle.trees[j]) continue
      if (cells[j] !== CS.Unknown) continue
      if (!tentCapable(puzzle, cells, j)) continue
      const tentOk = lineSolvable(puzzle, cells, line, clue, i, true)
      const grassOk = lineSolvable(puzzle, cells, line, clue, i, false)
      if (!tentOk && !grassOk) {
        conflicts.push(`${label}的线索 ${clue} 和已确定的格子矛盾，这一格放不放帐篷都不行`)
        continue
      }
      if (!tentOk) {
        cells[j] = CS.Grass
        steps.push({ index: j, value: CS.Grass, reason: `${label}的帐篷怎么摆都用不到这一格` })
      } else if (!grassOk) {
        cells[j] = CS.Tent
        steps.push({ index: j, value: CS.Tent, reason: `${label}的每一种摆法都必须在这一格放帐篷` })
      }
    }
  }

  for (let cy = 0; cy < h; cy++) {
    const line: number[] = []
    for (let cx = 0; cx < w; cx++) line.push(cellIndex(w, cx, cy))
    apply(puzzle.rowClues[cy], line, `第 ${cy + 1} 行`)
  }
  for (let cx = 0; cx < w; cx++) {
    const line: number[] = []
    for (let cy = 0; cy < h; cy++) line.push(cellIndex(w, cx, cy))
    apply(puzzle.colClues[cx], line, `第 ${cx + 1} 列`)
  }
  return steps
}

function areAdjacent8(w: number, a: number, b: number): boolean {
  const ax = a % w
  const ay = Math.floor(a / w)
  const bx = b % w
  const by = Math.floor(b / w)
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1
}

/* ———————————————————— 规则 6：树的行列归属 ———————————————————— */

/**
 * 树的行列归属（标准「树计数」定式）：
 * 每棵树最终要配一顶正交相邻的帐篷，所以它的帐篷一定在它候选格所在的行/列里。
 *   - 某棵树的候选格全在同一行 r ⇒ 这棵树的帐篷一定在第 r 行；
 *   - 于是第 r 行的帐篷里必然有它一顶。若这样的树超过线索数 ⇒ 冲突；
 *   - 若恰好等于线索数，说明第 r 行的帐篷全被这些树包了：该行里不挨着这些树
 *     的空地不可能放帐篷 ⇒ 草地。
 * 列同理。这条推理只看「候选格分布」，不猜配对，结论安全。
 */
const ruleTreeLine: RuleFn = ({ puzzle, cells, conflicts }) => {
  const steps: LogicStep[] = []
  const w = puzzle.width
  const h = puzzle.height
  const trees = treePositions(puzzle)

  const forcedRows: number[][] = Array.from({ length: h }, () => [])
  const forcedCols: number[][] = Array.from({ length: w }, () => [])
  for (const t of trees) {
    const rows = new Set<number>()
    const cols = new Set<number>()
    for (const nb of neighbors4(w, h, t.cx, t.cy)) {
      const j = cellIndex(w, nb.cx, nb.cy)
      if (puzzle.trees[j]) continue
      const v = cells[j]!
      if (v !== CS.Unknown && v !== CS.Tent) continue
      rows.add(nb.cy)
      cols.add(nb.cx)
    }
    if (rows.size === 0) {
      conflicts.push(`${cellLabel(puzzle, t.index)}的树已经没有任何能放帐篷的相邻格`)
      continue
    }
    if (rows.size === 1) forcedRows[[...rows][0]!]!.push(t.index)
    if (cols.size === 1) forcedCols[[...cols][0]!]!.push(t.index)
  }

  const rowForcedCells: number[][] = Array.from({ length: h }, () => [])
  for (let r = 0; r < h; r++) {
    const forced = forcedRows[r]!
    for (const tIndex of forced) {
      for (const nb of neighbors4(w, h, tIndex % w, Math.floor(tIndex / w))) {
        const j = cellIndex(w, nb.cx, nb.cy)
        if (puzzle.trees[j]) continue
        if (cells[j] === CS.Grass) continue
        if (nb.cy === r) rowForcedCells[r]!.push(j)
      }
    }
    const clue = puzzle.rowClues[r]
    if (clue === null || clue === undefined) continue
    if (forced.length > clue) {
      conflicts.push(`第 ${r + 1} 行必须容纳 ${forced.length} 棵树各自的帐篷，但线索只有 ${clue}`)
      continue
    }
    if (forced.length === 0 || forced.length !== clue) continue
    const pool = new Set(rowForcedCells[r]!)
    for (let cx = 0; cx < w; cx++) {
      const j = cellIndex(w, cx, r)
      if (puzzle.trees[j] || cells[j] !== CS.Unknown) continue
      if (pool.has(j)) continue
      cells[j] = CS.Grass
      steps.push({
        index: j,
        value: CS.Grass,
        reason: `第 ${r + 1} 行的帐篷数都被 ${forced.length} 棵树占满了，这一格挨不到属于它们的帐篷`,
      })
    }
  }

  const colForcedCells: number[][] = Array.from({ length: w }, () => [])
  for (let c = 0; c < w; c++) {
    const forced = forcedCols[c]!
    for (const tIndex of forced) {
      for (const nb of neighbors4(w, h, tIndex % w, Math.floor(tIndex / w))) {
        const j = cellIndex(w, nb.cx, nb.cy)
        if (puzzle.trees[j]) continue
        if (cells[j] === CS.Grass) continue
        if (nb.cx === c) colForcedCells[c]!.push(j)
      }
    }
    const clue = puzzle.colClues[c]
    if (clue === null || clue === undefined) continue
    if (forced.length > clue) {
      conflicts.push(`第 ${c + 1} 列必须容纳 ${forced.length} 棵树各自的帐篷，但线索只有 ${clue}`)
      continue
    }
    if (forced.length === 0 || forced.length !== clue) continue
    const pool = new Set(colForcedCells[c]!)
    for (let cy = 0; cy < h; cy++) {
      const j = cellIndex(w, c, cy)
      if (puzzle.trees[j] || cells[j] !== CS.Unknown) continue
      if (pool.has(j)) continue
      cells[j] = CS.Grass
      steps.push({
        index: j,
        value: CS.Grass,
        reason: `第 ${c + 1} 列的帐篷数都被 ${forced.length} 棵树占满了，这一格挨不到属于它们的帐篷`,
      })
    }
  }

  return steps
}

/* ———————————————————— 规则 7：匹配定式 ———————————————————— */

interface MatchingAnalysis {
  /** 每套完整匹配都占用的格子（必是帐篷） */
  essential: number[]
  conflicts: string[]
}

/**
 * 树 ↔ 可放帐篷格 二分图：
 *   - 左侧 = 所有树，右侧 = 所有「非树、未标草地」的格子（未定或已是帐篷）；
 *   - 边 = 正交相邻。
 * 先求一组覆盖全部树的匹配（覆盖不了 ⇒ Hall 条件失败，报冲突）；
 * 再从「没被匹配占用的右侧格」沿交替路做可达性：
 *   可达的右侧格都可以通过换配对空出来 ⇒ 不是必然帐篷；
 *   不可达且已被匹配占用的右侧格 ⇒ 每套完整匹配都会用它 ⇒ 必是帐篷。
 */
function analyzeMatching(puzzle: Puzzle, cells: CellState[]): MatchingAnalysis {
  const w = puzzle.width
  const h = puzzle.height
  const total = w * h
  const out: MatchingAnalysis = { essential: [], conflicts: [] }
  const trees = treePositions(puzzle)
  if (!trees.length) return out

  const rIndexOf = new Int32Array(total).fill(-1)
  const candidateCells: number[] = []
  for (let i = 0; i < total; i++) {
    if (puzzle.trees[i]) continue
    if (cells[i] === CS.Grass) continue
    rIndexOf[i] = candidateCells.length
    candidateCells.push(i)
  }

  const leftAdj: number[][] = []
  /** 每个右侧格相邻的树 ordinal（交替路用） */
  const cellTrees: number[][] = Array.from({ length: candidateCells.length }, () => [])
  for (let t = 0; t < trees.length; t++) {
    const tree = trees[t]!
    const adj: number[] = []
    for (const nb of neighbors4(w, h, tree.cx, tree.cy)) {
      const cell = cellIndex(w, nb.cx, nb.cy)
      const r = rIndexOf[cell]!
      if (r < 0) continue
      adj.push(r)
      cellTrees[r]!.push(t)
    }
    if (adj.length === 0) {
      out.conflicts.push(`${cellLabel(puzzle, tree.index)}的树已经没有任何能放帐篷的相邻格`)
      return out
    }
    leftAdj.push(adj)
  }

  const match = maximumMatching(leftAdj, candidateCells.length)
  if (match.size !== trees.length) {
    const k = match.leftMatch.findIndex((v) => v === -1)
    const t = k >= 0 ? trees[k] : undefined
    if (t) {
      out.conflicts.push(`${cellLabel(puzzle, t.index)}的树所在的一群树，可用的相邻格不够各自配一顶帐篷`)
    }
    return out
  }

  // 交替路可达性：右侧(空格) --未匹配边--> 左侧(树) --匹配边--> 右侧(被占用)
  const reachR = new Uint8Array(candidateCells.length)
  const reachL = new Uint8Array(trees.length)
  const stack: number[] = []
  for (let r = 0; r < candidateCells.length; r++) {
    if (match.rightMatch[r] !== -1) continue
    reachR[r] = 1
    stack.push(r)
  }
  while (stack.length) {
    const r = stack.pop()!
    for (const t of cellTrees[r]!) {
      if (match.rightMatch[r] === t) continue
      if (reachL[t]) continue
      reachL[t] = 1
      const r2 = match.leftMatch[t]!
      if (r2 < 0 || reachR[r2]) continue
      reachR[r2] = 1
      stack.push(r2)
    }
  }

  for (let r = 0; r < candidateCells.length; r++) {
    if (match.rightMatch[r] === -1) continue
    if (reachR[r]) continue
    out.essential.push(candidateCells[r]!)
  }
  return out
}

/** 匹配定式：每套完整匹配都占用的格子 → 帐篷；顺带报匹配矛盾 */
const ruleMatching: RuleFn = ({ puzzle, cells, conflicts }) => {
  // 先看已放的帐篷能不能各自配到不同的树（这是完整配对里绕不开的必要条件）
  const tentCells: number[] = []
  for (let i = 0; i < cells.length; i++) {
    if (puzzle.trees[i]) continue
    if (cells[i] === CS.Tent) tentCells.push(i)
  }
  if (tentCells.length) {
    const tentAdj = tentCells.map((index) => adjacentTrees(puzzle, index))
    const tentMatch = maximumMatching(tentAdj, puzzle.width * puzzle.height)
    if (tentMatch.size !== tentCells.length) {
      const k = tentMatch.leftMatch.findIndex((v) => v === -1)
      const first = k >= 0 ? tentCells[k] : undefined
      if (first !== undefined) {
        conflicts.push(`${cellLabel(puzzle, first)}的帐篷已经配不到一棵自己的树了`)
      }
    }
  }

  const analysis = analyzeMatching(puzzle, cells)
  for (const c of analysis.conflicts) conflicts.push(c)
  const steps: LogicStep[] = []
  if (analysis.conflicts.length) return steps
  const w = puzzle.width

  const forced: number[] = []
  for (const index of analysis.essential) {
    if (cells[index] !== CS.Unknown) continue
    forced.push(index)
  }
  // 两格必是帐篷却互相挨着 ⇒ 冲突
  for (let a = 0; a < forced.length; a++) {
    for (let b = a + 1; b < forced.length; b++) {
      if (areAdjacent8(w, forced[a]!, forced[b]!)) {
        conflicts.push(
          `匹配要求${cellLabel(puzzle, forced[a]!)}和${cellLabel(puzzle, forced[b]!)}都是帐篷，但两格互相挨着`,
        )
        return []
      }
    }
  }
  for (const j of forced) {
    cells[j] = CS.Tent
    steps.push({
      index: j,
      value: CS.Tent,
      reason: '匹配约束：这一格在每一套完整配对里都必须用来放帐篷',
    })
  }
  return steps
}

/* ———————————————————— 规则 8：相邻两行/列联合线解法 ———————————————————— */

/**
 * 相邻两行（或两列）的联合线解法（band DP）。
 * 单行线解法看不到「斜角互斥」：比如上一行第 4 格是帐篷时，下一行第 3/4/5 格
 * 都不能放。这里把相邻两行当成一个 2×L 的条带做 DP，同时满足：
 *   - 两行各自的线索帐篷数；
 *   - 各自行内帐篷不左右相邻；
 *   - 两行之间同列（上下）和斜角都不能同时有帐篷。
 * 依然是「只放宽、不额外假设」的松弛：真实解一定满足条带约束，所以在所有条带
 * 摆法里都成立/都不成立的格子，结论一定安全。
 *
 * 为了控制开销，只对相邻两行/两列都给出线索的题面做，且盘面较大时跳过（见调用处）。
 */
interface BandForce {
  line: 0 | 1
  index: number
  tent: boolean
}

function bandKind(
  puzzle: Puzzle,
  cells: CellState[],
  cell: number,
  forced: BandForce | null,
  line: 0 | 1,
  index: number,
): 0 | 1 | 2 {
  if (forced && forced.line === line && forced.index === index) return forced.tent ? 1 : 0
  if (puzzle.trees[cell]) return 0
  const v = cells[cell]!
  if (v === CS.Tent) return 1
  if (v === CS.Grass) return 0
  return tentCapable(puzzle, cells, cell) ? 2 : 0
}

function bandSolvable(
  puzzle: Puzzle,
  cells: CellState[],
  lineA: number[],
  lineB: number[],
  clueA: number,
  clueB: number,
  forced: BandForce | null,
): boolean {
  const L = lineA.length
  const aMax = Math.max(0, clueA)
  const bMax = Math.max(0, clueB)
  const stride = bMax + 1
  const patStride = stride * 4
  const size = (aMax + 1) * patStride
  let cur = new Uint8Array(size)
  cur[0 * patStride + 0] = 1 // a=0, b=0, pattern=0
  for (let i = 0; i < L; i++) {
    const next = new Uint8Array(size)
    const kindA = bandKind(puzzle, cells, lineA[i]!, forced, 0, i)
    const kindB = bandKind(puzzle, cells, lineB[i]!, forced, 1, i)
    for (let a = 0; a <= aMax; a++) {
      for (let b = 0; b <= bMax; b++) {
        for (let pat = 0; pat < 4; pat++) {
          if (!cur[a * patStride + b * 4 + pat]) continue
          const prevA = (pat >> 1) & 1
          const prevB = pat & 1
          for (let va = 0; va <= 1; va++) {
            if (kindA === 0 && va) continue
            if (kindA === 1 && !va) continue
            if (va && prevA) continue // 行内相邻
            for (let vb = 0; vb <= 1; vb++) {
              if (kindB === 0 && vb) continue
              if (kindB === 1 && !vb) continue
              if (vb && prevB) continue
              if (va && vb) continue // 同列上下相邻
              if (va && prevB) continue // 斜角
              if (vb && prevA) continue
              const na = a + va
              const nb = b + vb
              if (na > aMax || nb > bMax) continue
              next[na * patStride + nb * 4 + (va * 2 + vb)] = 1
            }
          }
        }
      }
    }
    cur = next
  }
  const base = aMax * patStride + bMax * 4
  return cur[base] === 1 || cur[base + 1] === 1 || cur[base + 2] === 1 || cur[base + 3] === 1
}

const ruleBand: RuleFn = ({ puzzle, cells, conflicts }) => {
  const steps: LogicStep[] = []
  const w = puzzle.width
  const h = puzzle.height
  // 大盘面上条带检查会比较贵：只对 ≤ 20×20 的题面启用（内置题最大 10×10）
  if (w * h > 400) return steps

  const applyPair = (
    lineA: number[],
    lineB: number[],
    clueA: number | null | undefined,
    clueB: number | null | undefined,
    label: string,
  ) => {
    if (clueA === null || clueA === undefined || clueB === null || clueB === undefined) return
    if (!bandSolvable(puzzle, cells, lineA, lineB, clueA, clueB, null)) {
      conflicts.push(`${label}的线索和已确定的格子矛盾，两行/列一起看放不下帐篷`)
      return
    }
    const lines = [lineA, lineB] as const
    for (let line = 0 as 0 | 1; line <= 1; line = (line + 1) as 0 | 1) {
      const arr = lines[line]!
      for (let i = 0; i < arr.length; i++) {
        const j = arr[i]!
        if (puzzle.trees[j] || cells[j] !== CS.Unknown) continue
        if (!tentCapable(puzzle, cells, j)) continue
        const tentOk = bandSolvable(puzzle, cells, lineA, lineB, clueA, clueB, { line, index: i, tent: true })
        const grassOk = bandSolvable(puzzle, cells, lineA, lineB, clueA, clueB, { line, index: i, tent: false })
        if (!tentOk && !grassOk) {
          conflicts.push(`${label}的线索和已确定的格子矛盾，这一格放不放帐篷都不行`)
          continue
        }
        if (!tentOk) {
          cells[j] = CS.Grass
          steps.push({ index: j, value: CS.Grass, reason: `${label}一起看，这一格放帐篷会撞上斜角/相邻的帐篷` })
        } else if (!grassOk) {
          cells[j] = CS.Tent
          steps.push({ index: j, value: CS.Tent, reason: `${label}一起看，这一格必须放帐篷才能凑够线索` })
        }
      }
    }
  }

  for (let r = 0; r + 1 < h; r++) {
    const lineA: number[] = []
    const lineB: number[] = []
    for (let cx = 0; cx < w; cx++) {
      lineA.push(cellIndex(w, cx, r))
      lineB.push(cellIndex(w, cx, r + 1))
    }
    applyPair(lineA, lineB, puzzle.rowClues[r], puzzle.rowClues[r + 1], `第 ${r + 1}/${r + 2} 行`)
  }
  for (let c = 0; c + 1 < w; c++) {
    const lineA: number[] = []
    const lineB: number[] = []
    for (let cy = 0; cy < h; cy++) {
      lineA.push(cellIndex(w, c, cy))
      lineB.push(cellIndex(w, c + 1, cy))
    }
    applyPair(lineA, lineB, puzzle.colClues[c], puzzle.colClues[c + 1], `第 ${c + 1}/${c + 2} 列`)
  }
  return steps
}

/* ———————————————————— 规则表 ———————————————————— */

/** 局部的「必然结论」规则（每一轮先跑到不动点） */export const RULES: RuleMeta[] = [
  { id: 'tent-surround', name: '帐篷周围 → 草地', fn: ruleTentSurround },
  { id: 'no-tree', name: '不挨树 → 草地', fn: ruleNoTree },
  { id: 'lone-tree', name: '树只剩唯一格 → 帐篷', fn: ruleLoneTree },
  { id: 'line-full', name: '行列线索达标 → 草地', fn: ruleLineFull },
  { id: 'line-solve', name: '行列线解法', fn: ruleLineSolve },
  { id: 'tree-line', name: '树的行列归属', fn: ruleTreeLine },
]

/** 全局匹配定式（局部规则推不动时才跑一次，避免每轮都做匹配） */
export const MATCHING_RULE: RuleMeta = {
  id: 'matching',
  name: '匹配强制/匹配矛盾',
  fn: ruleMatching,
}

/* ———————————————————— 主循环 ———————————————————— */

/** 线索合计必须等于树数（每棵树正好配一顶帐篷）；有 null 线索时无法比较 */
function totalClueConflicts(puzzle: Puzzle): string[] {
  const out: string[] = []
  const trees = puzzle.trees.filter(Boolean).length
  const rows = puzzle.rowClues
  if (rows.every((c) => c !== null && c !== undefined)) {
    const sum = rows.reduce((s, c) => s + (c as number), 0)
    if (sum !== trees) out.push(`行线索合计 ${sum} ≠ 树数 ${trees}，帐篷数对不上`)
  }
  const cols = puzzle.colClues
  if (cols.every((c) => c !== null && c !== undefined)) {
    const sum = cols.reduce((s, c) => s + (c as number), 0)
    if (sum !== trees) out.push(`列线索合计 ${sum} ≠ 树数 ${trees}，帐篷数对不上`)
  }
  return out
}

/** 反复跑规则到不动点；steps 按推出顺序收集 */
function infer(puzzle: Puzzle, start: CellState[]) {
  const cells = start.slice()
  const steps: LogicStep[] = []
  const conflicts: string[] = totalClueConflicts(puzzle)
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
    // 局部规则推不动时，依次用「匹配定式」和「相邻两行/列联合线解法」继续收
    if (!progressed) {
      const produced = MATCHING_RULE.fn(ctx)
      if (produced.length) {
        steps.push(...produced)
        progressed = true
      }
    }
    if (!progressed) {
      const produced = ruleBand(ctx)
      if (produced.length) {
        steps.push(...produced)
        progressed = true
      }
    }
    if (!progressed) break
  }

  // 推到不动点后再做一次匹配检查（只报冲突，不产生步骤）
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