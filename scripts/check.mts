/**
 * 题库审计：校验 src/puzzles-data.ts 里每道题
 *   1. 串长度与题面尺寸吻合
 *   2. 参考解通过 validate（四条规则全满足）
 *   3. 解唯一（countSolutions === 1）
 *
 * 用法：npm run check
 */
import { puzzles } from '../src/puzzles.ts'
import { countSolutions } from '../src/solver.ts'
import { createEmptyState } from '../src/state.ts'
import { validate } from '../src/validate.ts'
import { CellState as CS } from '../src/types.ts'

let fail = 0
const failIf = (cond: boolean, msg: string) => {
  if (cond) {
    console.log(`  ✗ ${msg}`)
    fail++
    return true
  }
  return false
}

console.log(`共 ${puzzles.length} 道题\n`)

for (const p of puzzles) {
  const w = p.width
  const h = p.height
  console.log(`${p.id}  ${w}×${h}  ${p.difficulty}`)

  let bad = false
  bad ||= failIf(p.trees.length !== w * h, `trees 长度 ${p.trees.length} ≠ ${w * h}`)
  bad ||= failIf(p.rowClues.length !== h, `rowClues 长度 ${p.rowClues.length} ≠ ${h}`)
  bad ||= failIf(p.colClues.length !== w, `colClues 长度 ${p.colClues.length} ≠ ${w}`)
  bad ||= failIf(!p.solution || p.solution.length !== w * h, 'solution 长度不对')
  if (bad) continue

  const treeCount = p.trees.filter(Boolean).length
  const tentCount = p.solution!.filter(Boolean).length
  bad ||= failIf(treeCount !== tentCount, `树 ${treeCount} ≠ 帐篷 ${tentCount}`)

  // 参考解合法性
  const st = createEmptyState(p)
  for (let i = 0; i < p.solution!.length; i++) {
    st.cells[i] = p.solution![i] ? CS.Tent : CS.Grass
  }
  const v = validate(st, p)
  bad ||= failIf(!v.solved, `参考解不合法：${JSON.stringify(v).slice(0, 160)}`)

  const r = countSolutions(p, 2, { maxNodes: 2_000_000, timeBudgetMs: 30_000 })
  bad ||= failIf(r.timedOut, '唯一解校验超时')
  bad ||= failIf(r.count !== 1, `解数 = ${r.count}（应为 1）`)

  console.log(`  ✓ 参考解合法 · 唯一解 · 树/帐篷 ${treeCount} · 线索行 ${p.rowClues.join(',')}`)
}

console.log('')
if (fail) {
  console.log(`失败 ${fail} 项`)
  process.exit(1)
}
console.log('全部通过')
