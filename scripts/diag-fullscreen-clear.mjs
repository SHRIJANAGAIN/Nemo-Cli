/* Measure ink's Windows fullscreen-clear behavior + our chrome heights.
 * Run: node scripts/diag-fullscreen-clear.mjs   (exit 0 = measurements printed)
 *
 * 1) Composition mirror: column box with round border + flexGrow content +
 *    fixed footer/composer rows, at height=rows vs height=rows-1 — prints
 *    ink's lastOutputHeight (the exact value shouldClearTerminalForFrame
 *    compares against viewportRows) and counts 2J/3J wipes across updates.
 * 2) Footer + PromptInput standalone heights (best effort).
 */
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href

const COLS = 100
const ROWS = 30

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

const React = (await import("react")).default
const { Box, Text, render } = await import("ink")

function makeStdout() {
  const stdout = new PassThrough()
  stdout.isTTY = true
  stdout.columns = COLS
  stdout.rows = ROWS
  return stdout
}

async function measureComposition(label, rootHeight, footerRows, composerRows) {
  const stdout = makeStdout()
  let bytes = ""
  stdout.on("data", (c) => {
    bytes += c.toString()
  })
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => {}

  const { default: MessageList } = await import(`${distEsm}/MessageList.js`)
  const msgs = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    timestamp: i,
    role: "user",
    content: `MSG-${i}`,
  }))

  let tick = 0
  function Root() {
    const [, force] = React.useState(0)
    React.useEffect(() => {
      const t = setInterval(() => {
        tick += 1
        force((n) => n + 1)
      }, 30)
      return () => clearInterval(t)
    }, [])
    return React.createElement(
      Box,
      { flexDirection: "column", height: rootHeight, borderStyle: "round" },
      React.createElement(
        Box,
        { flexDirection: "row", flexGrow: 1 },
        React.createElement(
          Box,
          { flexDirection: "column", flexGrow: 1 },
          React.createElement(MessageList, {
            messages: msgs,
            isLoading: true,
            isStreaming: true,
            phase: "running",
            turnStartedAt: Date.now() - 5000,
          }),
        ),
      ),
      React.createElement(
        Box,
        { flexShrink: 0, height: footerRows },
        React.createElement(Text, null, `footer ${tick}`),
      ),
      React.createElement(
        Box,
        { flexShrink: 0, height: composerRows },
        React.createElement(Text, null, `composer ${tick}`),
      ),
    )
  }

  const instance = render(React.createElement(Root), { stdin, stdout, patchConsole: false })
  await wait(250)
  const h1 = instance.lastOutputHeight
  const clears1 = (bytes.match(/\x1b\[2J/g) || []).length
  const wipes1 = (bytes.match(/\x1b\[3J/g) || []).length
  const bytesAtCheckpoint = bytes.length
  await wait(300)
  const h2 = instance.lastOutputHeight
  const clears2 = (bytes.match(/\x1b\[2J/g) || []).length - clears1
  const wipes2 = (bytes.match(/\x1b\[3J/g) || []).length - wipes1
  instance.unmount()
  log(
    `[${label}] rootHeight=${rootHeight} footer=${footerRows} composer=${composerRows} → lastOutputHeight=${h1}→${h2} (viewport=${ROWS}) fullscreen=${h1 >= ROWS} | wipes 2J=${clears1}+${clears2} 3J=${wipes1}+${wipes2} | bytes in 300ms of updates=${bytes.length - bytesAtCheckpoint}`,
  )
}

// Mirror App: root column (border + height) = messages(flex) + Footer + PromptInput.
await measureComposition("A: height=rows (current)", ROWS, 3, 2)
await measureComposition("B: height=rows-1 (proposed)", ROWS - 1, 3, 2)
await measureComposition("C: height=rows-1, footer=3 composer=3", ROWS - 1, 3, 3)

// What SHOULD the budget be for a box of H messages rows? Print the math.
log(`rowBudget rows-7 = ${ROWS - 7}; rows-8 = ${ROWS - 8}`)
process.exit(0)
