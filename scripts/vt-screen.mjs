/* Shared mini VT100 emulator for screen-level smokes.
 *
 * Replays the app's raw stdout byte stream into a screen grid (scrollback +
 * viewport) so oracles can assert what the USER sees, not what bytes left the
 * process. Handles cursor moves, ED/EL, SGR (ignored), OSC (skipped), autowrap
 * with deferred wrap, scrolling, ED3 (scrollback clear — Ink's clearTerminal
 * uses ESC[2J ESC[3J ESC[H), and width/height resize with hard-line reflow.
 *
 * Used by smoke-screen-replay.mjs and smoke-model-turn.mjs.
 */

export function createScreen(cols0, rows0) {
  let cols = cols0
  let rows = rows0
  const blank = () => Array(cols).fill(" ")
  let grid = Array.from({ length: rows }, blank)
  let scrollback = []
  let row = 0,
    col = 0,
    pendingWrap = false,
    autowrap = true
  const scroll = () => {
    const off = grid.shift()
    scrollback.push(off.join("").replace(/\s+$/, ""))
    grid.push(blank())
  }

  const clamp = () => {
    if (row < 0) row = 0
    if (row > rows - 1) row = rows - 1
    if (col < 0) col = 0
    if (col > cols - 1) col = cols - 1
  }
  const place = (ch) => {
    if (pendingWrap && autowrap) {
      row++
      col = 0
      pendingWrap = false
      if (row > rows - 1) {
        scroll()
        row = rows - 1
      }
    }
    grid[row][col] = ch
    if (col >= cols - 1) {
      pendingWrap = true
    } else {
      col++
    }
  }
  const eraseRange = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++) {
      if (r < 0 || r >= rows) continue
      const a = r === r0 ? c0 : 0
      const b = r === r1 ? c1 : cols - 1
      for (let c = Math.max(0, a); c <= Math.min(cols - 1, b); c++) grid[r][c] = " "
    }
  }

  let state = "norm" // norm | esc | csi | osc | charset
  let csi = ""

  const csiDispatch = (final, params, priv) => {
    pendingWrap = false
    const n = (i, d = 1) => {
      const v = parseInt(params[i], 10)
      return Number.isFinite(v) && v !== 0 ? v : d
    }
    if (priv) {
      if (final === "h" || final === "l") return // private modes: paste/sync/cursor/alt-screen — ignore
      if (final === "J" && n(0) === 3) return // scrollback clear — no grid effect
    }
    switch (final) {
      case "A":
        row -= n(0)
        clamp()
        break
      case "B":
        row += n(0)
        clamp()
        break
      case "C":
        col += n(0)
        clamp()
        break
      case "D":
        col -= n(0)
        clamp()
        break
      case "G":
        col = n(0) - 1
        clamp()
        break
      case "H":
      case "f":
        row = params.length > 0 && params[0] ? n(0) - 1 : 0
        col = params.length > 1 && params[1] ? n(1) - 1 : 0
        clamp()
        break
      case "J": {
        const m = parseInt(params[0] || "0", 10)
        // ED semantics: 0=cursor→end, 1=start→cursor, 2=viewport, 3=scrollback.
        if (m === 3) scrollback = []
        else if (m === 2) eraseRange(0, 0, rows - 1, cols - 1)
        else if (m === 0) eraseRange(row, col, rows - 1, cols - 1)
        else if (m === 1) eraseRange(0, 0, row, col)
        break
      }
      case "K": {
        const m = parseInt(params[0] || "0", 10)
        if (m === 2) eraseRange(row, 0, row, cols - 1)
        else if (m === 1) eraseRange(row, 0, row, col)
        else eraseRange(row, col, row, cols - 1)
        break
      }
      case "L": {
        // insert lines at cursor
        const count = n(0)
        for (let i = 0; i < count; i++) {
          grid.splice(row, 0, blank())
          grid.pop()
        }
        break
      }
      case "M": {
        // delete lines at cursor
        const count = n(0)
        for (let i = 0; i < count; i++) {
          grid.splice(row, 1)
          grid.push(blank())
        }
        break
      }
      case "@": {
        // insert blank chars
        const count = n(0)
        const line = grid[row]
        for (let i = 0; i < count; i++) line.splice(col, 0, " ")
        for (let i = 0; i < count; i++) line.pop()
        break
      }
      case "P": {
        // delete chars
        const count = n(0)
        const line = grid[row]
        for (let i = 0; i < count; i++) line.splice(col, 1)
        for (let i = 0; i < count; i++) line.push(" ")
        break
      }
      case "X": {
        // erase chars
        const count = n(0)
        eraseRange(row, col, row, Math.min(cols - 1, col + count - 1))
        break
      }
      case "m":
      case "r":
      case "s":
      case "u":
      case "n":
      case "l":
      case "h":
      case "t":
        break
      default:
        break
    }
  }

  const write = (str) => {
    for (const ch of str) {
      if (state === "norm") {
        if (ch === "\x1b") {
          state = "esc"
          continue
        }
        if (ch === "\r") {
          pendingWrap = false
          col = 0
          continue
        }
        if (ch === "\n") {
          pendingWrap = false
          row++
          col = 0
          if (row > rows - 1) {
            scroll()
            row = rows - 1
          }
          continue
        }
        if (ch === "\b") {
          pendingWrap = false
          col = Math.max(0, col - 1)
          continue
        }
        if (ch === "\t") {
          col = Math.min(cols - 1, col + 8)
          continue
        }
        if (ch < " ") continue
        place(ch)
      } else if (state === "esc") {
        if (ch === "[") {
          state = "csi"
          csi = ""
          continue
        }
        if (ch === "]") {
          state = "osc"
          csi = ""
          continue
        }
        if (ch === "(" || ch === ")") {
          state = "charset"
          continue
        }
        state = "norm"
        continue // ESC7/ESC8/=> etc.
      } else if (state === "charset") {
        state = "norm"
        continue
      } else if (state === "csi") {
        if (/[0-9;?]/.test(ch)) {
          csi += ch
          continue
        }
        const priv = csi.startsWith("?")
        const nums = csi.split(";").filter((s) => s.length > 0)
        state = "norm"
        csi = ""
        csiDispatch(ch, nums, priv)
        continue
      } else if (state === "osc") {
        if (ch === "\x07") {
          state = "norm"
          continue
        }
        if (ch === "\x1b") {
          state = "esc"
          continue
        } // ST \ — approx
        continue
      }
    }
  }

  const snapshot = () => grid.map((r) => r.join("").replace(/\s+$/, ""))
  // Screen order top→bottom: scrollback (what the window shows above the
  // viewport) followed by the viewport. The user's screenshots include
  // scrollback, so oracles must scan it too — stuck rows live there.
  const snapshotFull = () => scrollback.concat(snapshot())
  const scrollbackRows = () => scrollback.slice()
  // Terminal size change: reflow hard lines like a real terminal (split lines
  // longer than the new width; lines that un-wrap would rejoin, but we only
  // ever grow content here), move overflow between scrollback/viewport, keep
  // new rows blank at the bottom. Called BEFORE emitting stdout's resize
  // event — matching the real order (terminal reflows, then app is notified).
  const resizeTo = (newCols, newRows) => {
    const chunk = (line) => {
      if (line.length <= newCols) return [line]
      const parts = []
      for (let i = 0; i < line.length; i += newCols) parts.push(line.slice(i, i + newCols))
      return parts
    }
    const sb = []
    for (const l of scrollback) sb.push(...chunk(l))
    const vp = []
    for (const l of grid.map((r) => r.join(""))) vp.push(...chunk(l))
    cols = newCols
    rows = newRows
    if (vp.length > rows) sb.push(...vp.splice(0, vp.length - rows))
    while (vp.length < rows) vp.push("")
    grid = Array.from({ length: rows }, blank)
    vp.forEach((r, i) => {
      for (let c = 0; c < Math.min(r.length, cols); c++) grid[i][c] = r[c]
    })
    scrollback = sb.map((r) => r.replace(/\s+$/, ""))
    pendingWrap = false
    if (row > rows - 1) row = rows - 1
    if (col > cols - 1) col = cols - 1
  }
  return { write, snapshot, snapshotFull, scrollbackRows, resizeTo, size: () => ({ cols, rows }) }
}
