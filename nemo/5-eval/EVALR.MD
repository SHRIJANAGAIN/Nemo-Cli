# EVALR - Forced Mistake EvaluationOHK

Auto-loaded by `5-eval/eval.ts`. Every time a mistake occurs, the assistant MUST answer these questions and write the summary to this file. Every chat/session has a different evaluation. This file forces self-critique.

## EVALUATION CHECKLIST

When ANY mistake happens (tool use syntax error, wrong output, missed step, etc.), the assistant MUST ask itself:

### 1. What is the mistake?

- errorName:
- errorDescription:
- errorParagraph: (the full paragraph/context where the mistake occurred)

### 2. Why did I (the assistant) make this mistake?

- whyAssistantDidIt:
- reasonItHeld: (why did this mistake persist or go unnoticed?)

### 3. If I was in the place of the user, what would happen, and what would I do with the assistant?

- isUserMistake: (yes/no — did the user's instruction cause or contribute?)
- What would the user feel? (frustrated, confused, disappointed?)
- What would the user expect the assistant to do differently?
- isAssistantMistake: (yes/no — was this the assistant's fault?)
- isDeviceError: (yes/no — was this a system/tool error?)

### 4. How can I fix this mistake?

- howToResolve:

### 5. What is the solution of that mistake?

- solution:

### 6. Did I fix the mistake?

- isFixed: (yes/no)
- If yes, verify:
  - Is the fix verified and tested? ___
  - Does the fix address the root cause? ___

### 7. If not fixed, why did I fail to fix it?

- If isFixed = no:
  - whyFailed:
  - willRepeatInFuture: (yes/no)
  - futurePrevention:

## FORCED SELF-QUESTION RULES

- MISTAKE TYPES include but are NOT LIMITED to: tool use syntax errors, wrong file paths, missing file extensions, incorrect module resolution, stale build artifacts, path formatting issues, PowerShell vs bash command confusion, workdir parameter issues.
- Every mistake MUST be strictly noted and created as a MistakeEntry in `nemo/1-errors/mistakes.json`.
- Every mistake MUST trigger a question to the assistant: "What went wrong and how do I fix it?"
- The assistant MUST be careful and double-check all file paths, imports, and command syntax before executing.
- If a mistake repeats, reliability score is docked by 10 points per repeat.

## EVAL PROCESS

1. Before each task, read `EVALS.MD` for reliability score and past mistakes.
2. After each task with mistakes, read `EVALR.MD` and answer all questions above.
3. Store the answered template as a summary in the conversation.
4. Create a MistakeEntry using `logMistake()` in `nemo/1-errors/mistake.ts`.
5. If fixed, call `markFixed()`.

## CURRENT SESSION

(Each session fills in below when a mistake occurs)

---

_File: nemo/5-eval/EVALR.MD — loaded before every task that involves tool use or code changes._
