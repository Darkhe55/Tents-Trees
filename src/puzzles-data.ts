/* 自动生成，勿手改。scripts/gen-puzzles.mts（npm run gen） */
export type RawPuzzle = {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy'|'medium'|'hard'|'custom'
  series: string
  /** 树位图：'#' = 树，'.' = 空地；length = W*H，row-major */
  trees: string
  /** 行线索，逗号分隔，length = H */
  rows: string
  /** 列线索，逗号分隔，length = W */
  cols: string
  /** 参考解：'o' = 帐篷，'.' = 空地；length = W*H，row-major */
  solution: string
}

export const RAW_PUZZLES: RawPuzzle[] = [
  { id: "starter-6x6", name: "入门 · 6×6", width: 6, height: 6, difficulty: "easy", series: "starter", trees: ".#..#.....#.#.#.....#..........#...#", rows: "1,2,1,1,2,1", cols: "2,1,1,2,0,2", solution: "...o...o...o...o..o.......o..oo....." },
  { id: "starter-7x7", name: "入门 · 7×7", width: 7, height: 7, difficulty: "easy", series: "starter", trees: ".#....##...#....#........#.....#...##...#....#...", rows: "2,1,2,1,2,1,2", cols: "2,1,2,1,2,1,2", solution: "..o.o........oo..o........o.o.o..........o.o..o.." },
  { id: "classic-8x8-A", name: "经典 · 8×8 A", width: 8, height: 8, difficulty: "medium", series: "classic", trees: ".......##.#.........##.#.##.......#.....#...##..#..........#...#", rows: "3,1,1,3,1,2,1,3", cols: "3,1,3,1,2,1,3,1", solution: "o.o...o.....o....o.........o.o.oo.........o...o.....o...o.o...o." },
  { id: "classic-8x8-B", name: "经典 · 8×8 B", width: 8, height: 8, difficulty: "medium", series: "classic", trees: ".......##.#.........#....#...##..#.#...#.#.......#.......#..#..#", rows: "3,1,2,1,2,2,2,2", cols: "3,1,3,1,2,1,3,1", solution: "o.o...o.....o....o....o....o....o....o....o....oo...o.....o...o." },
  { id: "classic-9x9", name: "经典 · 9×9", width: 9, height: 9, difficulty: "medium", series: "classic", trees: "#......#....#.#.......##....##.....#........#.#....#.#...#.....#..###..........#.", rows: "3,1,3,2,1,3,1,2,3", cols: "4,0,2,2,2,2,2,1,4", solution: "...o.o..oo..........o...o.oo...o...........o.o..o.o...........o..o...o..o...o...o" },
  { id: "challenge-10x10", name: "挑战 · 10×10", width: 10, height: 10, difficulty: "hard", series: "challenge", trees: "...#....#.##......#......#..#.#.##....#.........#.....#..#....#......#..#......##....##......#....#.", rows: "3,2,3,1,4,1,2,2,2,3", cols: "3,2,3,2,2,1,2,3,1,4", solution: "o.o......o.....o.o...o.o.....o.......o..o.o.o....o......o......o....o..o....o.......o....oo.o....o.." },
]
