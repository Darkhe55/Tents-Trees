import { chromium } from 'playwright-core'

// 默认使用 playwright 探测到的 Chromium，可用 PLAYWRIGHT_CHROMIUM_PATH 覆盖
const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? chromium.executablePath()

const b = await chromium.launch({ headless: true, executablePath: EXE })
const p = await b.newPage({ viewport: { width: 1280, height: 900 } })
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => {
  if (m.type() === 'error') errs.push('CONSOLE ' + m.text())
})
await p.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' })
console.log('题目数:', await p.locator('.puzzle-item').count())
console.log('当前题:', await p.locator('.puzzle-item.active .title').textContent())
console.log('树:', await p.locator('.board-svg .tree').count())
console.log('帐篷:', await p.locator('.board-svg .tent').count())
console.log('线索:', await p.locator('.board-svg .clue').count())
console.log('状态栏:', await p.locator('#status').textContent())
console.log('JS 报错:', errs.length ? errs.join(' | ') : '无')
await b.close()
