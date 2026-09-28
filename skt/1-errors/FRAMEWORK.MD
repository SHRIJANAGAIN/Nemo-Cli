# SKT AI LABS — Self-Improvement Framework

## Overview

Trayambak tracks every mistake, applies penalties, and computes a **reliability score** that feeds into the reward engine. The goal is a closed loop: **mistake → fix → prevention → improvement**.

## Pipeline

```
1-errors/mistake.ts  ──records──>  mistakes.json
1-errors/penalty.ts  ──applies──>  penalties.json
6-u/improvements.ts  ──logs───>    improvements.json
5-eval/eval.ts       ──scores──>   evals.json
6-u/reward.ts        ──rewards─>   rewards.json
```

## Mistake Lifecycle

1. **Log** — When an error occurs, `logMistake()` records the full context:
   - `errorName`, `errorDescription`, `errorParagraph`
   - `userInput`, `assistantOutput` (truncated for storage)
   - `whyAssistantDidIt`, `reasonItHeld`
   - `isUserMistake`, `isAssistantMistake`, `isDeviceError`
   - `howToResolve`
   - `isFixed` (default false), `willRepeatInFuture` (default false), `isRepeated`

2. **Repeat Detection** — `isRepeatedMistake()` checks if the same `errorName` exists and is still open. If a repeat is detected within the 24-hour sliding window, the **2nd-mistake detector** applies a 2× penalty multiplier.

3. **Penalty** — `applyPenalty()` deducts points based on mistake severity:

   | Error class                        | Base penalty |
   | ---------------------------------- | ------------ |
   | syntax / import / type             | 1            |
   | io / permission / config / network | 2            |
   | logic / tool                       | 3            |
   | timeout / oom                      | 4            |
   | hallucination                      | 10           |
   | device / user_error                | 0            |
   | unknown                            | 2            |

   Repeated mistakes multiply the base by **2×**. User complaints multiply by **3×**.

4. **Mark Fixed** — `markFixed()` sets `isFixed = true` and stores a `futurePrevention` note. This removes the mistake from the active repeat-detection pool.

5. **Prevent** — `markWillRepeat()` sets `willRepeatInFuture = true` for mistakes deemed likely to recur. The agent reads these flagged mistakes in the SKT context block and receives explicit guidance to avoid them.

6. **Improve** — `logImprovement()` records fixes with `beforeState` / `afterState` snapshots. Verified improvements increase the reliability score.

## Reliability Score

```
reliability = improvements / (improvements + repeats)
```

- **reliability >= 0.8** for 7 consecutive days → bonus +5 per high/critical task
- **reliability < 0.5** → restricted to "easy" tasks only

## How the Agent Uses This

1. On every task, the agent reads `mistakes.json` and `IMPROVEMENT.MD` via `getSktContextBlock()`.
2. Open (unfixed) mistakes with `willRepeatInFuture = true` are surfaced as explicit avoidance rules in the system prompt.
3. After resolving a mistake, the agent calls `markFixed()` with a `futurePrevention` note.
4. After completing a task with no errors, the agent logs an improvement via `logImprovement()`.

## Never Repeat

The cardinal rule: **a fixed mistake must never recur.** Every `markFixed` call must include a `futurePrevention` note describing how the agent will avoid the same error in future sessions.
