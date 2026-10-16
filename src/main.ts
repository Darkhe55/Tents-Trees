import './styles.css'
import type { CellState, GameState, Move, Puzzle } from './types'
import { CellState as CS } from './types'
import {
  actionValue,
  applyMove,
  cellValue,
  createEmptyState,
  deserializeState,
  invertMove,
  isTree,
  leftAction,
  rightAction,
  serializeState,
  type PaintAction,
} from './state'
import { getPuzzle, puzzles, randomPuzzle, treeCount } from './puzzles'
import { cellCenter, clientToViewBox, hitTestCell, metricsFor, renderBoard, updateFlash, updateHover } from './render'
import { validate } from './validate'
import { countSolutions } from './solver'
import { planLogicSolve } from './logic'
import { isMuted, resumeAudio, setMuted } from './audio'
import { bumpStreak, fxNegative, fxPositive } from './fx'

const SAVE_PREFIX = 'tents-save:'

interface Session {
  puzzle: Puzzle
  state: GameState
  /** 一次手势/一次操作算一个撤销单元 */
  undo: Move[][]
  redo: Move[][]
}

function $(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el
}

function $input(sel: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el
}

/* ———————————————————— 存档 ———————————————————— */

function loadSave(puzzleId: string): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_PREFIX + puzzleId)
    if (!raw) return null
    const data = JSON.parse(raw) as {
      version: number
      puzzleId: string
      width: number
      height: number
      cells: number[]
    }
    if (data.version !== 1) return null
    return deserializeState(data)
  } catch {
    return null
  }
}

function saveState(session: Session): void {
  localStorage.setItem(
    SAVE_PREFIX + session.puzzle.id,
    JSON.stringify(serializeState(session.state)),
  )
}

function difficultyLabel(d: Puzzle['difficulty']): string {
  return d === 'easy' ? '入门' : d === 'medium' ? '进阶' : d === 'custom' ? '自定义' : '挑战'
}

/* ———————————————————— 页面骨架 ———————————————————— */

const app = document.querySelector('#app')
if (!app) throw new Error('no #app')

app.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <h1>帐篷</h1>
      <p>Tents · 每棵树配一个相邻帐篷 · 每个帐篷只挨一棵树 · 帐篷互不相邻 · 行列数字 = 帐篷数</p>
    </div>
    <div class="brand">
      <p style="margin:0">左键标记帐篷，右键标记空地</p>
    </div>
  </header>

  <div class="layout">
    <aside class="panel">
      <h2>题面</h2>
      <div class="toolbar" style="margin-top:0">
        <button class="btn" id="btn-random" type="button">随机抽题</button>
        <button class="btn" id="btn-mute" type="button">音效：开</button>
        <button class="btn" id="btn-custom" type="button">自定义</button>
      </div>
      <div class="puzzle-list" id="puzzle-list"></div>

      <div class="custom-editor" id="custom-editor" hidden>
        <h2>自定义题板</h2>
        <div class="custom-row">
          <label>宽 <input id="custom-w" type="number" min="3" max="14" value="6" /></label>
          <label>高 <input id="custom-h" type="number" min="3" max="14" value="6" /></label>
          <button class="btn" id="custom-regen" type="button">生成网格</button>
        </div>
        <div class="custom-hint">点击格子种树（再点取消），然后「载入题板」。行列线索会自动算。</div>
        <div class="custom-grid" id="custom-grid"></div>
        <div class="toolbar" style="margin-top:10px">
          <button class="btn primary" id="custom-apply" type="button">载入题板</button>
          <button class="btn" id="custom-unique" type="button">唯一解校验</button>
          <button class="btn danger" id="custom-close" type="button">关闭</button>
        </div>
        <div class="custom-msg" id="custom-msg"></div>
      </div>

      <div class="toolbar">
        <button class="btn primary" id="btn-check" type="button">检查</button>
        <button class="btn" id="btn-undo" type="button">撤销</button>
        <button class="btn" id="btn-redo" type="button">重做</button>
        <button class="btn" id="btn-hint" type="button">提示一格</button>
        <button class="btn" id="btn-logic" type="button">逻辑解题</button>
        <button class="btn" id="btn-solve" type="button">显示解</button>
        <button class="btn danger" id="btn-clear" type="button">清空</button>
      </div>

      <div class="status" id="status">选择左侧题目开始。</div>

      <div class="legend">
        <div><kbd>左键</kbd> 标记帐篷 · 再点取消</div>
        <div><kbd>右键</kbd> 标记空地 · 再点取消 · <kbd>拖拽</kbd> 连续涂同一动作</div>
        <div><kbd>滚轮</kbd> 缩放 · <kbd>中键拖拽</kbd> 平移 · <kbd>0</kbd> 复位视图</div>
        <div><kbd>Z</kbd> 撤销 · <kbd>Shift+Z</kbd> 重做</div>
        <div><kbd>C</kbd> 检查 · <kbd>H</kbd> 提示 · <kbd>S</kbd> 显示解 · <kbd>Esc</kbd> 清空</div>
        <div><kbd>R</kbd> 随机抽题 · <kbd>L</kbd> 逻辑解题 · <kbd>M</kbd> 音效开关</div>
      </div>
    </aside>

    <main class="panel board-wrap" id="board-wrap">
      <div class="zoom-bar">
        <button class="btn" id="zoom-out" type="button" title="缩小">−</button>
        <span class="zoom-label" id="zoom-label">100%</span>
        <button class="btn" id="zoom-in" type="button" title="放大">+</button>
        <button class="btn" id="zoom-reset" type="button">复位</button>
      </div>
      <div id="board"></div>
    </main>
  </div>
`

let session: Session | null = null

/* ———————————————————— 刷新 ———————————————————— */

function setStatus(text: string, tone: 'ok' | 'bad' | 'solving' | '' = '') {
  const el = $('#status')
  el.textContent = text
  el.className = 'status' + (tone ? ` ${tone}` : '')
}

function renderPuzzleList() {
  const list = $('#puzzle-list')
  list.innerHTML = puzzles
    .map((p) => {
      const active = session?.puzzle.id === p.id ? ' active' : ''
      return `
        <button class="puzzle-item${active}" data-id="${p.id}" type="button">
          <span class="title">${p.name}</span>
          <span class="meta">${p.width}×${p.height} · ${difficultyLabel(p.difficulty)} · ${treeCount(p)} 棵树</span>
        </button>
      `
    })
    .join('')

  list.querySelectorAll<HTMLButtonElement>('.puzzle-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      const p = id ? getPuzzle(id) : undefined
      if (p) selectPuzzle(p)
    })
  })
}

function currentSvg(): SVGSVGElement | null {
  return $('#board').querySelector<SVGSVGElement>('svg.board-svg')
}

function renderBoardOnly() {
  if (!session) return
  const result = validate(session.state, session.puzzle)
  $('#board').innerHTML = renderBoard(session.puzzle, session.state, result)
  const svg = currentSvg()
  if (svg) {
    const m = metricsFor(session.puzzle)
    if (hoverCell !== null) updateHover(svg, m, hoverCell)
    if (flashCell !== null) updateFlash(svg, m, flashCell)
  }
}

function refresh() {
  renderPuzzleList()
  renderBoardOnly()
  if (!session) return
  const result = validate(session.state, session.puzzle)
  $('#board-wrap').classList.toggle('solved', result.solved)

  if (result.solved) {
    setStatus('完成！每棵树都配到了帐篷，数字全部吻合。', 'ok')
    return
  }
  const bits: string[] = [`已定 ${result.filled}/${session.puzzle.width * session.puzzle.height - treeCount(session.puzzle)} 块空地`]
  if (result.badTrees.length) bits.push(`${result.badTrees.length} 棵树的帐篷数不对`)
  if (result.badTents.length) bits.push(`${result.badTents.length} 个帐篷挨错了树`)
  if (result.adjacentTents.length) bits.push('有帐篷挨在一起')
  if (result.badRows.length) bits.push(`${result.badRows.length} 行数字不符`)
  if (result.badCols.length) bits.push(`${result.badCols.length} 列数字不符`)
  if (
    !result.badTrees.length &&
    !result.badTents.length &&
    !result.adjacentTents.length &&
    !result.badRows.length &&
    !result.badCols.length
  ) {
    bits.push('目前没有冲突')
  }
  setStatus(bits.join(' · '))
}

/* ———————————————————— 落子 ———————————————————— */

function moveFor(index: number, to: CellState): Move | null {
  if (!session) return null
  const from = cellValue(session.state, index)
  if (from === to) return null
  return { index, from, to }
}

function pushMoves(moves: Array<Move | null>): number {
  if (!session) return 0
  const group = moves.filter((m): m is Move => m !== null)
  if (!group.length) return 0
  for (const mv of group) applyMove(session.state, mv)
  session.undo.push(group)
  session.redo.length = 0
  saveState(session)
  return group.length
}

function setCells(targets: Array<{ index: number; value: CellState }>): number {
  if (!session) return 0
  const n = pushMoves(targets.map((t) => moveFor(t.index, t.value)))
  if (n) refresh()
  return n
}

function undo(): void {
  if (!session) return
  const group = session.undo.pop()
  if (!group) return
  for (let i = group.length - 1; i >= 0; i--) applyMove(session.state, invertMove(group[i]!))
  session.redo.push(group)
  saveState(session)
  refresh()
}

function redo(): void {
  if (!session) return
  const group = session.redo.pop()
  if (!group) return
  for (const mv of group) applyMove(session.state, mv)
  session.undo.push(group)
  saveState(session)
  refresh()
}

function clearBoard(): void {
  if (!session) return
  stopLogic()
  const targets = []
  for (let i = 0; i < session.puzzle.width * session.puzzle.height; i++) {
    targets.push({ index: i, value: CS.Unknown })
  }
  if (setCells(targets)) setStatus('已清空。')
}

function showSolution(): void {
  if (!session) return
  stopLogic()
  const sol = session.puzzle.solution
  if (!sol) {
    setStatus('这道题没有参考解（自定义题没有预存解）。', 'bad')
    return
  }
  const targets = sol.map((v, index) => ({ index, value: v ? CS.Tent : CS.Grass }))
  if (setCells(targets)) setStatus('已显示参考解（可撤销）。', 'solving')
}

function hint(): void {
  if (!session) return
  stopLogic()
  const sol = session.puzzle.solution
  if (!sol) {
    setStatus('这道题没有参考解，无法提示。', 'bad')
    return
  }
  const unknown: number[] = []
  for (let i = 0; i < sol.length; i++) {
    if (session.puzzle.trees[i]) continue
    if (cellValue(session.state, i) === CS.Unknown) unknown.push(i)
  }
  if (!unknown.length) {
    setStatus('已经没有空着的空地了。')
    return
  }
  const pick = unknown[Math.floor(Math.random() * unknown.length)]!
  const value = sol[pick] ? CS.Tent : CS.Grass
  if (setCells([{ index: pick, value }])) {
    setStatus(value === CS.Tent ? '已提示一格：这里是帐篷。' : '已提示一格：这里是草地。', 'solving')
  }
}

function check(): void {
  if (!session) return
  const result = validate(session.state, session.puzzle)
  if (result.solved) {
    setStatus('检查通过：已解出。', 'ok')
    return
  }
  const bits: string[] = ['检查结果：']
  if (result.unknown) bits.push(`还有 ${result.unknown} 块空地未定`)
  if (result.badTrees.length) bits.push(`${result.badTrees.length} 棵树的帐篷数不对（已标红）`)
  if (result.badTents.length) bits.push(`${result.badTents.length} 个帐篷挨错了树`)
  if (result.adjacentTents.length) bits.push('有帐篷挨在一起')
  if (result.badRows.length) bits.push(`${result.badRows.length} 行数字不符`)
  if (result.badCols.length) bits.push(`${result.badCols.length} 列数字不符`)
  setStatus(bits.join(' · '), result.badTrees.length || result.badTents.length || result.adjacentTents.length ? 'bad' : '')
}

/* ———————————————————— 选题 ———————————————————— */

function selectPuzzle(puzzle: Puzzle): void {
  stopLogic()
  const saved = loadSave(puzzle.id)
  session = {
    puzzle,
    state: saved ?? createEmptyState(puzzle),
    undo: [],
    redo: [],
  }
  refresh()
  resetView()
  setStatus(`已载入「${puzzle.name}」。左键在空地上放帐篷。`)
}

function pickRandomPuzzle(): void {
  selectPuzzle(randomPuzzle(session?.puzzle.id))
}

/* ———————————————————— 悬停 ———————————————————— */

let hoverCell: number | null = null

function clearHover(): void {
  hoverCell = null
  const svg = currentSvg()
  if (svg && session) updateHover(svg, metricsFor(session.puzzle), null)
}

function updateHoverAt(clientX: number, clientY: number): void {
  if (!session) return
  const svg = currentSvg()
  if (!svg) return
  const vb = clientToViewBox(svg, clientX, clientY)
  if (!vb) return
  const m = metricsFor(session.puzzle)
  const cell = hitTestCell(m, session.puzzle, vb.x, vb.y)
  if (cell === hoverCell) return
  hoverCell = cell
  updateHover(svg, m, cell)
}

/* ———————————————————— 手势 ———————————————————— */

interface Gesture {
  mode: 'paint' | 'pan'
  /** 落子动作：由起始格决定，整段拖拽保持不变 */
  action: PaintAction
  lastCell: number
  startX: number
  startY: number
  moved: boolean
  pointerId: number
}

let gesture: Gesture | null = null

/** 给一格落子；树格跳过。「取消」动作不发音效 */
function paintCell(cell: number, action: PaintAction, force = false): boolean {
  if (!session || isTree(session.puzzle, cell)) return false
  const value = actionValue(action)
  if (!setCells([{ index: cell, value }])) return false
  if (value === CS.Tent) playCellFx(cell, true, force)
  else if (value === CS.Grass) playCellFx(cell, false, force)
  return true
}

function boardPointerDown(e: PointerEvent): void {
  resumeAudio()
  // 推理播放中玩家直接下手，就当打断
  stopLogic()
  if (!session) return
  const svg = currentSvg()
  if (!svg) return
  const m = metricsFor(session.puzzle)

  const panGesture = (): Gesture => ({
    mode: 'pan',
    action: 'clear',
    lastCell: -1,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    pointerId: e.pointerId,
  })

  // 中键：平移
  if (e.button === 1) {
    e.preventDefault()
    gesture = panGesture()
    return
  }

  // 只认左键 / 右键
  if (e.button !== 0 && e.button !== 2) return

  const vb = clientToViewBox(svg, e.clientX, e.clientY)
  if (!vb) return
  const cell = hitTestCell(m, session.puzzle, vb.x, vb.y)

  // 按在棋盘外 → 平移
  if (cell === null) {
    gesture = panGesture()
    return
  }

  // 动作由起始格的状态决定，整段拖拽沿用同一个动作
  const action = e.button === 2
    ? rightAction(cellValue(session.state, cell))
    : leftAction(cellValue(session.state, cell))
  gesture = {
    mode: 'paint',
    action,
    lastCell: cell,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    pointerId: e.pointerId,
  }
  paintCell(cell, action, true)
  hoverCell = cell
}

function boardPointerMove(e: PointerEvent): void {
  if (!gesture) {
    updateHoverAt(e.clientX, e.clientY)
    return
  }
  if (e.pointerId !== gesture.pointerId) return

  if (gesture.mode === 'pan') {
    const dx = e.clientX - gesture.startX
    const dy = e.clientY - gesture.startY
    if (!gesture.moved && Math.hypot(dx, dy) < 5) return
    gesture.moved = true
    panBy(dx, dy)
    gesture.startX = e.clientX
    gesture.startY = e.clientY
    return
  }

  if (Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > 8) gesture.moved = true
  const svg = currentSvg()
  if (!svg || !session) return
  const vb = clientToViewBox(svg, e.clientX, e.clientY)
  if (!vb) return
  const m = metricsFor(session.puzzle)
  const cell = hitTestCell(m, session.puzzle, vb.x, vb.y)
  if (cell === null || cell === gesture.lastCell) return
  gesture.lastCell = cell
  // 拖拽连续涂：沿用起始格定下的动作；特效内部有节流，避免一屏音符
  paintCell(cell, gesture.action)
}

function boardPointerUp(e: PointerEvent): void {
  if (!gesture || e.pointerId !== gesture.pointerId) return
  gesture = null
}

function bindBoard(): void {
  const board = $('#board')
  board.addEventListener('contextmenu', (e) => e.preventDefault())
  board.addEventListener('pointerdown', boardPointerDown)
  board.addEventListener('pointerleave', () => {
    if (!gesture) clearHover()
  })
  board.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const svg = currentSvg()
      if (!svg || !session) return
      const vb = clientToViewBox(svg, e.clientX, e.clientY)
      setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), vb ?? undefined)
    },
    { passive: false },
  )
  window.addEventListener('pointermove', boardPointerMove)
  window.addEventListener('pointerup', boardPointerUp)
  window.addEventListener('pointercancel', boardPointerUp)
}

/* ———————————————————— 缩放 / 平移 ———————————————————— */

let zoom = 1
let panX = 0
let panY = 0

function baseVB() {
  if (!session) return { w: 100, h: 100 }
  const m = metricsFor(session.puzzle)
  return { w: m.svgWidth, h: m.svgHeight }
}

function applyViewBox(): void {
  const svg = currentSvg()
  if (!svg) return
  const { w, h } = baseVB()
  svg.setAttribute('viewBox', `${panX} ${panY} ${w / zoom} ${h / zoom}`)
}

function clampPan(): void {
  const { w, h } = baseVB()
  const vw = w / zoom
  const vh = h / zoom
  panX = Math.min(Math.max(panX, Math.min(0, w - vw)), Math.max(0, w - vw))
  panY = Math.min(Math.max(panY, Math.min(0, h - vh)), Math.max(0, h - vh))
}

function setZoom(next: number, anchor?: { x: number; y: number }): void {
  if (!session) return
  const prev = zoom
  zoom = Math.min(Math.max(next, 0.5), 3)
  if (zoom === prev) return
  if (anchor) {
    panX = anchor.x - (anchor.x - panX) * (prev / zoom)
    panY = anchor.y - (anchor.y - panY) * (prev / zoom)
  }
  clampPan()
  applyViewBox()
  updateZoomLabel()
}

function panBy(dxScreen: number, dyScreen: number): void {
  const svg = currentSvg()
  if (!svg) return
  const rect = svg.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const { w, h } = baseVB()
  panX -= (dxScreen / rect.width) * (w / zoom)
  panY -= (dyScreen / rect.height) * (h / zoom)
  clampPan()
  applyViewBox()
}

function resetView(): void {
  zoom = 1
  panX = 0
  panY = 0
  applyViewBox()
  updateZoomLabel()
}

function updateZoomLabel(): void {
  $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`
}

/* ———————————————————— 逻辑解题 ———————————————————— */

let flashCell: number | null = null
/** 正在播放推理步骤 */
let logicPlaying = false
/** 播放中被用户操作打断 */
let logicCancelled = false

/** 每步之间的停留时间，够看清高亮 */
const STEP_MS = 110

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stopLogic(): void {
  flashCell = null
  logicCancelled = true
  const svg = currentSvg()
  if (svg && session) updateFlash(svg, metricsFor(session.puzzle), null)
}

async function runLogicSolver(): Promise<void> {
  if (!session) return
  if (logicPlaying) {
    setStatus('逻辑解题：正在播放，先等这轮放完。', 'solving')
    return
  }

  // 从当前盘面推，玩家已标的格子会作为前提
  const plan = planLogicSolve(session.puzzle, session.state.cells)

  if (!plan.supported) {
    setStatus(`逻辑解题：${plan.reason}`, 'solving')
    return
  }
  if (plan.conflicts.length) {
    setStatus(`逻辑解题：盘面对不上 —— ${plan.conflicts[0]}`, 'bad')
    return
  }
  if (!plan.steps.length) {
    setStatus(
      plan.complete ? '逻辑解题：都推完了，没有新结论。' : '逻辑解题：三条规则推不动了，剩下的要假设推演。',
      'solving',
    )
    return
  }

  logicPlaying = true
  logicCancelled = false
  setStatus(`逻辑解题：推出 ${plan.steps.length} 步，播放中…`, 'solving')

  let cancelled = false
  try {
    for (const step of plan.steps) {
      if (logicCancelled) {
        cancelled = true
        break
      }
      // 先记下高亮格，setCells 里的 refresh 会顺手画出来
      flashCell = step.index
      setCells([{ index: step.index, value: step.value }])
      await sleep(STEP_MS)
    }
  } catch (err) {
    console.error('逻辑解题播放异常：', err)
    setStatus('逻辑解题：播放中断。', 'bad')
  } finally {
    logicPlaying = false
    stopLogic()
  }
  if (cancelled) return

  const result = validate(session.state, session.puzzle)
  if (result.solved) setStatus('逻辑解题：推出完整解。', 'ok')
  else if (plan.complete) setStatus(`逻辑解题：${plan.steps.length} 步全部落盘。`, 'ok')
  else setStatus(`逻辑解题：落了 ${plan.steps.length} 步，剩下的要假设推演。`, 'solving')
}

/* ———————————————————— 自定义题板 ———————————————————— */

let customW = 6
let customH = 6
let customTrees: boolean[] = new Array<boolean>(36).fill(false)

function customMsg(text: string, tone: 'ok' | 'bad' | '' = '') {
  const el = $('#custom-msg')
  el.textContent = text
  el.className = 'custom-msg' + (tone ? ` ${tone}` : '')
}

function customIndex(px: number, py: number): number {
  return py * (customW + 1) + px
}

function renderCustomGrid(): void {
  const grid = $('#custom-grid')
  grid.style.gridTemplateColumns = `repeat(${customW + 1}, 34px)`
  const parts: string[] = []
  for (let py = 0; py <= customH; py++) {
    for (let px = 0; px <= customW; px++) {
      const i = customIndex(px, py)
      const on = customTrees[i] === true
      parts.push(
        `<button class="custom-cell${on ? ' tree' : ''}" type="button" data-i="${i}">${on ? '🌲' : ''}</button>`,
      )
    }
  }
  grid.innerHTML = parts.join('')
  grid.querySelectorAll<HTMLButtonElement>('.custom-cell').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i)
      customTrees[i] = !customTrees[i]
      renderCustomGrid()
    })
  })
}

function readCustomSize(): void {
  customW = Math.min(Math.max(Number($input('#custom-w').value) || 6, 3), 14)
  customH = Math.min(Math.max(Number($input('#custom-h').value) || 6, 3), 14)
}

function regenCustomGrid(): void {
  readCustomSize()
  customTrees = new Array<boolean>((customW + 1) * (customH + 1)).fill(false)
  renderCustomGrid()
  customMsg(`已生成 ${customW}×${customH} 网格，点击格子种树。`)
}

function openCustomEditor(): void {
  $('#custom-editor').hidden = false
  readCustomSize()
  customTrees = new Array<boolean>((customW + 1) * (customH + 1)).fill(false)
  renderCustomGrid()
  customMsg('点击格子种树，然后「载入题板」。')
}

function closeCustomEditor(): void {
  $('#custom-editor').hidden = true
  customMsg('')
}

/** 用当前自定义树位构造题面（行列线索留空） */
function customPuzzle(): Puzzle {
  return {
    id: `custom-${customW}x${customH}-${Date.now().toString(36)}`,
    name: `自定义 ${customW}×${customH}`,
    width: customW,
    height: customH,
    trees: customTrees.slice(),
    rowClues: new Array<number | null>(customH).fill(null),
    colClues: new Array<number | null>(customW).fill(null),
    difficulty: 'custom',
  }
}

/** 唯一解校验：自定义题不给行列线索，只能确认「有解/唯一」 */
function checkCustomUnique(): void {
  readCustomSize()
  if (!customTrees.some(Boolean)) {
    customMsg('至少种一棵树。', 'bad')
    return
  }
  const t0 = Date.now()
  const r = countSolutions(customPuzzle(), 2, { maxNodes: 400_000, timeBudgetMs: 8000 })
  if (r.timedOut) {
    customMsg(`校验超时（${Date.now() - t0}ms）：树太多或盘面太大，求解器跑不动。`, 'bad')
    return
  }
  if (r.count === 0) customMsg('无解：这些树配不出合法帐篷（可能有树挨太近或没有空位）。', 'bad')
  else if (r.count === 1) customMsg(`唯一解 ✓（${Date.now() - t0}ms）`, 'ok')
  else customMsg(`有 ${r.count}+ 个解，不是唯一解。`, 'bad')
}

function loadCustomPuzzle(): void {
  readCustomSize()
  const trees = customTrees.slice()
  const treeNum = trees.filter(Boolean).length
  if (!treeNum) {
    customMsg('至少种一棵树。', 'bad')
    return
  }
  // 行/列线索未知（自定义题不给线索），让玩家自己推
  const puzzle: Puzzle = {
    id: `custom-${customW}x${customH}-${Date.now().toString(36)}`,
    name: `自定义 ${customW}×${customH}`,
    width: customW,
    height: customH,
    trees,
    rowClues: new Array<number | null>(customH).fill(null),
    colClues: new Array<number | null>(customW).fill(null),
    difficulty: 'custom',
  }
  closeCustomEditor()
  selectPuzzle(puzzle)
}

/* ———————————————————— 落子特效 + 音效 ———————————————————— */

let lastFxAt = 0

/** 落子/排除的特效：弦振（线段）或形变（图形）+ 对应音效 */
function playCellFx(cell: number, positive: boolean, force = false): void {
  // 拖拽连续涂时节流：同一时间只保留一个音/一段动画
  if (!force) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (now - lastFxAt < 70) return
    lastFxAt = now
  }
  if (!session) return
  const svg = currentSvg()
  if (!svg) return
  const m = metricsFor(session.puzzle)
  const cx = cell % m.width
  const cy = Math.floor(cell / m.width)
  const center = cellCenter(m, cx, cy)
  const el = svg.querySelector<SVGElement>(`[data-cell="${cell}"]`)
  const streak = bumpStreak(positive ? 'pos' : 'neg')
  if (positive) fxPositive({ svg, positiveEl: el, center }, streak)
  else fxNegative({ svg, positiveEl: null, negativeEl: el, center }, streak)
}

function toggleMute(): void {
  const next = !isMuted()
  setMuted(next)
  const btn = document.querySelector<HTMLButtonElement>('#btn-mute')
  if (btn) btn.textContent = next ? '音效：关' : '音效：开'
}


/* ———————————————————— 键盘 ———————————————————— */

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault()
    undo()
  } else if ((k === 'z' && e.shiftKey) || k === 'y') {
    e.preventDefault()
    redo()
  } else if (k === 'c') {
    check()
  } else if (k === 'r') {
    pickRandomPuzzle()
  } else if (k === 'h') {
    hint()
  } else if (k === 's') {
    showSolution()
  } else if (k === 'l') {
    runLogicSolver()
  } else if (k === 'm') {
    toggleMute()
  } else if (k === 'escape') {
    clearBoard()
  } else if (k === '0') {
    resetView()
  } else if (k === '+' || k === '=') {
    setZoom(zoom * 1.15)
  } else if (k === '-') {
    setZoom(zoom / 1.15)
  }
})

/* ———————————————————— 绑定按钮 ———————————————————— */

$('#btn-random').addEventListener('click', pickRandomPuzzle)
$('#btn-mute').addEventListener('click', toggleMute)
$('#btn-custom').addEventListener('click', openCustomEditor)
$('#btn-check').addEventListener('click', check)
$('#btn-undo').addEventListener('click', undo)
$('#btn-redo').addEventListener('click', redo)
$('#btn-hint').addEventListener('click', hint)
$('#btn-logic').addEventListener('click', runLogicSolver)
$('#btn-solve').addEventListener('click', showSolution)
$('#btn-clear').addEventListener('click', clearBoard)
$('#zoom-in').addEventListener('click', () => setZoom(zoom * 1.15))
$('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.15))
$('#zoom-reset').addEventListener('click', resetView)
$('#custom-regen').addEventListener('click', regenCustomGrid)
$('#custom-apply').addEventListener('click', loadCustomPuzzle)
$('#custom-unique').addEventListener('click', checkCustomUnique)
$('#custom-close').addEventListener('click', closeCustomEditor)

bindBoard()

/* ———————————————————— 启动 ———————————————————— */

selectPuzzle(puzzles[0]!)
setStatus(`已载入「${puzzles[0]!.name}」。左键在空地上放帐篷。`)

;(window as unknown as { __tents: unknown }).__tents = {
  get session() {
    return session
  },
  validate: () => (session ? validate(session.state, session.puzzle) : null),
  setCell: (i: number, v: CellState) => setCells([{ index: i, value: v }]),
}
