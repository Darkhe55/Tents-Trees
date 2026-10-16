/**
 * 帐篷冒烟测试：先 `npm run build && npx vite preview --port 5201`，再 `node scripts/ui-check.mjs`
 *
 * 端口被占用时 vite 会自动顺延，用第一个参数指定实际地址：
 *   node scripts/ui-check.mjs http://127.0.0.1:5202/
 */
import { chromium } from 'playwright-core'

const HOOK = '__tents'
// 默认使用 playwright 探测到的 Chromium，可用 PLAYWRIGHT_CHROMIUM_PATH 覆盖
const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? chromium.executablePath()
const BASE = process.argv[2] ?? 'http://127.0.0.1:5201/'

async function waitForServer(url, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('preview server 没起来')
}

const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
}

let browser = null
try {
  await waitForServer(BASE)
  browser = await chromium.launch({ headless: true, executablePath: EXE })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  ok('无 JS 报错', errors.length === 0, errors.join(' | '))
  ok('题库渲染', (await page.locator('.puzzle-item').count()) === 6)
  ok('棋盘 SVG 渲染', (await page.locator('svg.board-svg').count()) === 1)
  ok('树渲染', (await page.locator('.board-svg .tree').count()) === 8)
  ok('线索渲染', (await page.locator('.board-svg .clue').count()) === 12)
  // 行/列线索必须画在棋盘格子区域之外
  const clueOutside = await page.evaluate(() => {
    const svg = document.querySelector('svg.board-svg')
    const c = svg.querySelector('rect.cell').getBBox()
    return [...svg.querySelectorAll('text.clue')].every((t) => {
      const b = t.getBBox()
      return b.x + b.width <= c.x + 0.5 || b.y + b.height <= c.y + 0.5
    })
  })
  ok('线索在棋盘外', clueOutside)

  // 按参考解填 → 判定完成
  const solved = await page.evaluate(async () => {
    const api = window.__tents
    const s = api.session
    const sol = s.puzzle.solution
    for (let i = 0; i < sol.length; i++) api.setCell(i, sol[i] ? 1 : 2)
    await new Promise((r) => setTimeout(r, 50))
    const v = api.validate()
    return { solved: v.solved, status: document.querySelector('#status').textContent }
  })
  ok('按参考解填满 → 判定完成', solved.solved === true, solved.status)

  // 撤销
  const afterUndo = await page.evaluate(async () => {
    const before = window.__tents.session.state.cells.filter((c) => c !== 0).length
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }))
    await new Promise((r) => setTimeout(r, 40))
    return { before, after: window.__tents.session.state.cells.filter((c) => c !== 0).length }
  })
  ok('Z 键撤销生效', afterUndo.after < afterUndo.before, `${afterUndo.before} → ${afterUndo.after}`)

  // 重做
  const afterRedo = await page.evaluate(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', shiftKey: true, bubbles: true }))
    await new Promise((r) => setTimeout(r, 40))
    return window.__tents.session.state.cells.filter((c) => c !== 0).length
  })
  ok('Shift+Z 重做生效', afterRedo === afterUndo.before, `${afterRedo}`)

  // 逻辑解题：从空盘推，推出的格子必须都和参考解一致
  await page.evaluate(() => {
    const api = window.__tents
    const n = api.session.puzzle.width * api.session.puzzle.height
    for (let i = 0; i < n; i++) api.setCell(i, 0)
  })
  await page.click('#btn-logic')
  await page.waitForFunction(
    () =>
      /完整解|全部落盘|剩下的要假设推演|推不动|没有新结论|盘面对不上|中断/.test(
        document.querySelector('#status')?.textContent ?? '',
      ),
    { timeout: 40000 },
  )
  const logicResult = await page.evaluate(() => {
    const api = window.__tents
    const p = api.session.puzzle
    const sol = p.solution
    const cells = api.session.state.cells
    const wrong = []
    for (let i = 0; i < sol.length; i++) {
      if (p.trees[i]) continue
      const expect = sol[i] ? 1 : 2
      if (cells[i] !== 0 && cells[i] !== expect) wrong.push(i)
    }
    return {
      status: document.querySelector('#status').textContent,
      filled: cells.filter((v, i) => !p.trees[i] && v !== 0).length,
      wrongCount: wrong.length,
    }
  })
  ok(
    '逻辑解题推出的格子都与参考解一致',
    logicResult.wrongCount === 0 && logicResult.filled > 0,
    `落 ${logicResult.filled} 格 · 错 ${logicResult.wrongCount} · ${logicResult.status}`,
  )

  // 随机抽题
  await page.click('#btn-random')
  const randomName = await page.locator('.puzzle-item.active .title').textContent()
  ok('随机抽题', !!randomName, randomName || '')

  // 真实鼠标点击一个空地
  await page.evaluate(() => {
    const n = window.__tents.session.puzzle.width * window.__tents.session.puzzle.height
    for (let i = 0; i < n; i++) window.__tents.setCell(i, 0)
  })
  const target = await page.evaluate(() => {
    const s = window.__tents.session
    for (let i = 0; i < s.puzzle.trees.length; i++) if (!s.puzzle.trees[i]) return i
    return -1
  })
  const w = await page.evaluate(() => window.__tents.session.puzzle.width)
  const svgBox = await page.locator('svg.board-svg').boundingBox()
  // 格子原点取首格实际坐标，不依赖渲染层的内边距常量
  const geom = await page.evaluate(() => {
    const svg = document.querySelector('svg.board-svg')
    const v = svg.viewBox.baseVal
    const c = svg.querySelector('rect.cell').getBBox()
    return { vb: { x: v.x, y: v.y, w: v.width, h: v.height }, origin: { x: c.x, y: c.y } }
  })
  const cx = target % w
  const cy = Math.floor(target / w)
  const px = svgBox.x + ((geom.origin.x + (cx + 0.5) * 48) / geom.vb.w) * svgBox.width
  const py = svgBox.y + ((geom.origin.y + (cy + 0.5) * 48) / geom.vb.h) * svgBox.height
  const beforeClick = await page.evaluate((t) => window.__tents.session.state.cells[t], target)
  await page.mouse.click(px, py)
  const afterClick = await page.evaluate((t) => window.__tents.session.state.cells[t], target)
  ok('鼠标点击空地可落子', afterClick !== beforeClick, `${beforeClick} → ${afterClick}`)

  /* ———————— 点击语义：左右键两段式 + 拖拽动作锁定 ———————— */

  const clearAll = () =>
    page.evaluate((h) => {
      const s = window[h].session
      for (let i = 0; i < s.puzzle.trees.length; i++) window[h].setCell(i, 0)
    }, HOOK)

  /** 第一个非树格的屏幕坐标 */
  const cellPoint = async () =>
    page.evaluate((h) => {
      const s = window[h].session
      let idx = -1
      for (let i = 0; i < s.puzzle.trees.length; i++) if (!s.puzzle.trees[i]) { idx = i; break }
      const svg = document.querySelector('svg.board-svg')
      // 格子原点取首格实际坐标，避免依赖渲染层的内边距常量
      const origin = svg.querySelector('rect.cell').getBBox()
      const p = svg.createSVGPoint()
      p.x = origin.x + ((idx % s.puzzle.width) + 0.5) * 48
      p.y = origin.y + (Math.floor(idx / s.puzzle.width) + 0.5) * 48
      const q = p.matrixTransform(svg.getScreenCTM())
      return { x: q.x, y: q.y, idx }
    }, HOOK)

  const cellVal = (idx) => page.evaluate((t) => window.__tents.session.state.cells[t], idx)

  // 左键：空 → 帐篷 → 空
  await clearAll()
  let pt = await cellPoint()
  await page.mouse.click(pt.x, pt.y, { button: 'left' })
  await page.waitForTimeout(60)
  const l1 = await cellVal(pt.idx)
  await page.mouse.click(pt.x, pt.y, { button: 'left' })
  await page.waitForTimeout(60)
  const l2 = await cellVal(pt.idx)
  ok('左键：空地 → 帐篷 → 空地', l1 === 1 && l2 === 0, `${l1} → ${l2}`)

  // 右键：空 → 草地 → 空
  await clearAll()
  pt = await cellPoint()
  await page.mouse.click(pt.x, pt.y, { button: 'right' })
  await page.waitForTimeout(60)
  const r1 = await cellVal(pt.idx)
  await page.mouse.click(pt.x, pt.y, { button: 'right' })
  await page.waitForTimeout(60)
  const r2 = await cellVal(pt.idx)
  ok('右键：空地 → 草地 → 空地', r1 === 2 && r2 === 0, `${r1} → ${r2}`)

  // 右键：帐篷 → 草地
  await clearAll()
  pt = await cellPoint()
  await page.evaluate((t) => window.__tents.setCell(t, 1), pt.idx)
  await page.mouse.click(pt.x, pt.y, { button: 'right' })
  await page.waitForTimeout(60)
  ok('右键：帐篷 → 草地', (await cellVal(pt.idx)) === 2)

  // 左键：草地 → 帐篷
  await clearAll()
  pt = await cellPoint()
  await page.evaluate((t) => window.__tents.setCell(t, 2), pt.idx)
  await page.mouse.click(pt.x, pt.y, { button: 'left' })
  await page.waitForTimeout(60)
  ok('左键：草地 → 帐篷', (await cellVal(pt.idx)) === 1)

  // 横向相邻的两个空地，用于拖拽测试
  const dragPair = await page.evaluate((h) => {
    const s = window[h].session
    const w = s.puzzle.width
    const trees = s.puzzle.trees
    const at = (cx, cy) => cy * w + cx
    let a = -1
    let b = -1
    for (let cy = 0; cy < s.puzzle.height && a < 0; cy++) {
      for (let cx = 0; cx < w - 1; cx++) {
        if (!trees[at(cx, cy)] && !trees[at(cx + 1, cy)]) { a = at(cx, cy); b = at(cx + 1, cy); break }
      }
    }
    if (a < 0) return null
    const svg = document.querySelector('svg.board-svg')
    const origin = svg.querySelector('rect.cell').getBBox()
    const toPt = (i) => {
      const p = svg.createSVGPoint()
      p.x = origin.x + ((i % w) + 0.5) * 48
      p.y = origin.y + (Math.floor(i / w) + 0.5) * 48
      const q = p.matrixTransform(svg.getScreenCTM())
      return { x: q.x, y: q.y }
    }
    return { a, b, pa: toPt(a), pb: toPt(b) }
  }, HOOK)

  const dragVals = (a, b) =>
    page.evaluate(
      (t) => [window.__tents.session.state.cells[t.a], window.__tents.session.state.cells[t.b]],
      { a, b },
    )

  /** 从 a 格起按 button 拖到 b 格；preset 为起始格的预设值 */
  const doDrag = async (button, preset) => {
    await clearAll()
    await page.evaluate((t) => window.__tents.setCell(t.i, t.v), { i: dragPair.a, v: preset })
    await page.mouse.move(dragPair.pa.x, dragPair.pa.y)
    await page.mouse.down({ button })
    await page.mouse.move(dragPair.pb.x, dragPair.pb.y, { steps: 5 })
    await page.mouse.up({ button })
    await page.waitForTimeout(80)
    return dragVals(dragPair.a, dragPair.b)
  }

  if (!dragPair) {
    console.log('· 找不到相邻空地，跳过拖拽测试')
  } else {
    const dl = await doDrag('left', 0)
    ok('左键拖拽：经过格都变帐篷', dl[0] === 1 && dl[1] === 1, JSON.stringify(dl))
    const dr = await doDrag('right', 0)
    ok('右键拖拽：经过格都变草地', dr[0] === 2 && dr[1] === 2, JSON.stringify(dr))
    const dc = await doDrag('left', 1)
    ok('左键从帐篷起拖：锁定为取消', dc[0] === 0 && dc[1] === 0, JSON.stringify(dc))
    const dcr = await doDrag('right', 2)
    ok('右键从草地起拖：锁定为取消', dcr[0] === 0 && dcr[1] === 0, JSON.stringify(dcr))
  }

  // 地面底色：树 / 帐篷 / 草地 带浅绿底，空地不带
  const ground = await page.evaluate(() => {
    const svg = document.querySelector('svg.board-svg')
    const s = window.__tents.session
    const trees = s.puzzle.trees
    const cells = s.state.cells
    const rects = [...svg.querySelectorAll('rect.cell')]
    const has = (i) => (rects[i]?.getAttribute('class') ?? '').includes('ground')
    const bad = { tree: [], tent: [], grass: [], empty: [] }
    for (let i = 0; i < trees.length; i++) {
      if (trees[i]) { if (!has(i)) bad.tree.push(i) }
      else if (cells[i] === 1) { if (!has(i)) bad.tent.push(i) }
      else if (cells[i] === 2) { if (!has(i)) bad.grass.push(i) }
      else if (has(i)) bad.empty.push(i)
    }
    return bad
  })
  const groundBad = Object.entries(ground).filter(([, v]) => v.length)
  ok('地面底色：树/帐篷/草地有，空地无', groundBad.length === 0, groundBad.length ? JSON.stringify(ground) : '')

  // 自定义题板
  await page.click('#btn-custom')
  ok('自定义编辑器打开', await page.locator('#custom-editor').isVisible())
  const customCells = await page.locator('.custom-cell').count()
  ok('自定义网格 7×7 顶点', customCells === 49, String(customCells))
  await page.click('.custom-cell')
  await page.click('#custom-apply')
  const customOk = await page.evaluate(() => {
    const s = window.__tents.session
    return {
      difficulty: s.puzzle.difficulty,
      name: s.puzzle.name,
      trees: s.puzzle.trees.filter(Boolean).length,
      rowCluesAllNull: s.puzzle.rowClues.every((c) => c === null),
    }
  })
  ok(
    '载入自定义题板',
    customOk.difficulty === 'custom' && customOk.trees >= 1 && customOk.rowCluesAllNull,
    JSON.stringify(customOk),
  )

  await page.screenshot({ path: 'output/ui-check.png', fullPage: true })
} catch (err) {
  console.error('运行异常：', err)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exit(1)
