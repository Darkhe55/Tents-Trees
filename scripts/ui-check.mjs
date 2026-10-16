/**
 * 帐篷冒烟测试：先 `npm run build && npx vite preview --port 5175`，再 `node scripts/ui-check.mjs`
 */
import { chromium } from 'playwright-core'

const HOOK = '__tents'
// 默认使用 playwright 探测到的 Chromium，可用 PLAYWRIGHT_CHROMIUM_PATH 覆盖
const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? chromium.executablePath()
const BASE = 'http://127.0.0.1:5201/'

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

try {
  await waitForServer(BASE)
  const browser = await chromium.launch({ headless: true, executablePath: EXE })
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

  // 逻辑解题预留提示
  await page.click('#btn-logic')
  const logicMsg = await page.locator('#status').textContent()
  ok('逻辑解谜器预留提示', /尚未实现/.test(logicMsg || ''), logicMsg)

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
  const vb = await page.evaluate(() => {
    const v = document.querySelector('svg.board-svg').viewBox.baseVal
    return { x: v.x, y: v.y, w: v.width, h: v.height }
  })
  const cx = target % w
  const cy = Math.floor(target / w)
  const px = svgBox.x + ((vb.x + 48 * 0.78 + (cx + 0.5) * 48 - vb.x) / vb.w) * svgBox.width
  const py = svgBox.y + ((48 * 0.78 + (cy + 0.5) * 48 - vb.y) / vb.h) * svgBox.height
  const beforeClick = await page.evaluate((t) => window.__tents.session.state.cells[t], target)
  await page.mouse.click(px, py)
  const afterClick = await page.evaluate((t) => window.__tents.session.state.cells[t], target)
  ok('鼠标点击空地可落子', afterClick !== beforeClick, `${beforeClick} → ${afterClick}`)

  // 左键循环必须能走完：填上 → 标记 → 清除（ historically 清除那步被守卫挡住过）
  // 先把目标格子清空，保证从「未定」开始
  await page.evaluate((h) => {
    const s = window[h].session
    for (let i = 0; i < s.puzzle.trees ? s.puzzle.trees.length : s.puzzle.givens.length; i++) {
      const fixed = s.puzzle.trees ? s.puzzle.trees[i] : s.puzzle.givens[i]
      if (!fixed) { window[h].setCell(i, 0); break }
    }
  }, HOOK)
  const cycleSeq = []
  for (let k = 0; k < 3; k++) {
    const pt = await page.evaluate((h) => {
      const s = window[h].session
      let idx = -1
      for (let i = 0; i < s.puzzle.trees.length; i++) if (!s.puzzle.trees[i]) { idx = i; break }
      const svg = document.querySelector('svg.board-svg')
      const m = svg.getScreenCTM()
      const p = svg.createSVGPoint()
      p.x = 48 * 0.78 + ((idx % s.puzzle.width) + 0.5) * 48
      p.y = 48 * 0.78 + (Math.floor(idx / s.puzzle.width) + 0.5) * 48
      const q = p.matrixTransform(m)
      return { x: q.x, y: q.y, idx }
    }, HOOK)
    await page.mouse.click(pt.x, pt.y)
    await page.waitForTimeout(80)
    const v = await page.evaluate((t) => window[t.h].session.state.cells[t.idx], { h: HOOK, idx: pt.idx })
    cycleSeq.push(v)
  }
  ok('左键循环可走完（含清除）', JSON.stringify(cycleSeq) === '[1,2,0]', JSON.stringify(cycleSeq))

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
  await browser.close()
} catch (err) {
  console.error('运行异常：', err)
  process.exitCode = 1
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exit(1)
