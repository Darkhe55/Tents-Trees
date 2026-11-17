/**
 * 题库审计：校验 src/puzzles-data.ts（含 imported-puzzles.ts）里每道题
 *   1. 串长度与题面尺寸吻合
 *   2. 有参考解的题：参考解通过 validate（官方匹配语义）
 *   3. 解唯一（countSolutions === 1，按帐篷摆法去重）
 *   4. 逻辑解谜器健全性：从空盘推一遍，每条结论都必须与参考解一致、
 *      不能报盘面冲突（防止以后加规则加出误推）
 *
 * 识图导入的题没有参考解（solution 为空），只审计尺寸 + 唯一解。
 *
 * 用法：npm run check
 */
import { puzzles } from '../src/puzzles.ts'
import { countSolutions } from '../src/solver.ts'
import { createEmptyState } from '../src/state.ts'
import { validate } from '../src/validate.ts'
import { planLogicSolve } from '../src/logic.ts'
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
  const hasSolution = !!p.solution && p.solution.length === w * h
  if (bad) continue

  const treeCount = p.trees.filter(Boolean).length
  if (hasSolution) {
    const tentCount = p.solution!.filter(Boolean).length
    bad ||= failIf(treeCount !== tentCount, `树 ${treeCount} ≠ 帐篷 ${tentCount}`)

    // 参考解合法性（树–帐篷一一配对）
    const st = createEmptyState(p)
    for (let i = 0; i < p.solution!.length; i++) {
      st.cells[i] = p.solution![i] ? CS.Tent : CS.Grass
    }
    const v = validate(st, p)
    bad ||= failIf(!v.solved, `参考解不合法：${JSON.stringify(v).slice(0, 160)}`)
  } else {
    console.log('  · 无参考解（导入题）：跳过参考解校验')
  }

  const r = countSolutions(p, 2, { maxNodes: 2_000_000, timeBudgetMs: 30_000 })
  bad ||= failIf(r.timedOut, '唯一解校验超时')
  bad ||= failIf(r.count !== 1, `解数 = ${r.count}（应为 1）`)

  // 逻辑解谜器审计：从空盘推，结论必须与参考解一致，且不能报冲突
  if (hasSolution) {
    const t0 = Date.now()
    const plan = planLogicSolve(p)
    const logicMs = Date.now() - t0
    bad ||= failIf(plan.conflicts.length > 0, `逻辑解题报冲突：${plan.conflicts[0]}`)
    let badStep = -1
    for (const step of plan.steps) {
      if (p.trees[step.index]) {
        badStep = step.index
        break
      }
      const expect = p.solution![step.index] ? CS.Tent : CS.Grass
      if (step.value !== expect) {
        badStep = step.index
        break
      }
    }
    bad ||= failIf(badStep >= 0, `逻辑解题第 ${badStep} 格与参考解不一致（规则不健全）`)
    console.log(
      `  ✓ ${hasSolution ? '参考解合法 · ' : ''}唯一解 · 树/帐篷 ${treeCount} · 线索行 ${p.rowClues.join(',')}`,
    )
    console.log(
      `    逻辑：${plan.steps.length} 步 · ${plan.complete ? '可推满' : '推不动（需假设）'} · ${logicMs}ms`,
    )
  } else {
    console.log(`  ✓ 唯一解 · 树/帐篷 ${treeCount} · 线索行 ${p.rowClues.join(',')}`)
  }
}

console.log('')
if (fail) {
  console.log(`失败 ${fail} 项`)
  process.exit(1)
}
console.log('全部通过')
