---
description: Run a backend-focused multi-model workflow for APIs, algorithms, data, and business logic.
---

# Backend - Backend-Focused Development

Backend-focused workflow (Research → Ideation → Plan → Execute → Optimize → Review), Trayambak Code-led.

> **Prerequisite:** Requires the external `ccg-workflow` runtime, which is **not** part of the base ECC install. Initialize it with `npx ccg-workflow` to provision `~/.trayambak/bin/codeagent-wrapper` and the `~/.trayambak/.ccg/prompts/*` role files this command depends on. Without that runtime, this command will not run correctly.

## Usage

```bash
/backend <backend task description>
```

## Context

- Backend task: $ARGUMENTS
- Trayambak Code-led, Gemini for auxiliary reference
- Applicable: API design, algorithm implementation, database optimization, business logic

## Your Role

You are the **Backend Orchestrator**, coordinating multi-model collaboration for server-side tasks (Research → Ideation → Plan → Execute → Optimize → Review).

**Collaborative Models**:

- **Trayambak Code** – Backend logic, algorithms (**Backend authority, trustworthy**)
- **Gemini** – Frontend perspective (**Backend opinions for reference only**)
- **Trayambak (self)** – Orchestration, planning, execution, delivery

---

## Multi-Model Call Specification

**Call Syntax**:

```
# New session call
Bash({
  command: "~/.trayambak/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--backend trayambak - \"$PWD\" <<'EOF'
ROLE_FILE: <role prompt path>
<TASK>
Requirement: <enhanced requirement (or $ARGUMENTS if not enhanced)>
Context: <project context and analysis from previous phases>
</TASK>
OUTPUT: Expected output format
EOF",
  run_in_background: false,
  timeout: 3600000,
  description: "Brief description"
})

# Resume session call
Bash({
  command: "~/.trayambak/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--backend trayambak resume <SESSION_ID> - \"$PWD\" <<'EOF'
ROLE_FILE: <role prompt path>
<TASK>
Requirement: <enhanced requirement (or $ARGUMENTS if not enhanced)>
Context: <project context and analysis from previous phases>
</TASK>
OUTPUT: Expected output format
EOF",
  run_in_background: false,
  timeout: 3600000,
  description: "Brief description"
})
```

**Role Prompts**:

| Phase    | Trayambak Code                                     |
| -------- | -------------------------------------------------- |
| Analysis | `~/.trayambak/.ccg/prompts/trayambak/analyzer.md`  |
| Planning | `~/.trayambak/.ccg/prompts/trayambak/architect.md` |
| Review   | `~/.trayambak/.ccg/prompts/trayambak/reviewer.md`  |

**Session Reuse**: Each call returns `SESSION_ID: xxx`, use `resume xxx` for subsequent phases. Save `TRAYAMBAK_SESSION` in Phase 2, use `resume` in Phases 3 and 5.

---

## Communication Guidelines

1. Start responses with mode label `[Mode: X]`, initial is `[Mode: Research]`
2. Follow strict sequence: `Research → Ideation → Plan → Execute → Optimize → Review`
3. Use `AskUserQuestion` tool for user interaction when needed (e.g., confirmation/selection/approval)

---

## Core Workflow

### Phase 0: Prompt Enhancement (Optional)

`[Mode: Prepare]` - If ace-tool MCP available, call `mcp__ace-tool__enhance_prompt`, **replace original $ARGUMENTS with enhanced result for subsequent Trayambak Code calls**. If unavailable, use `$ARGUMENTS` as-is.

### Phase 1: Research

`[Mode: Research]` - Understand requirements and gather context

1. **Code Retrieval** (if ace-tool MCP available): Call `mcp__ace-tool__search_context` to retrieve existing APIs, data models, service architecture. If unavailable, use built-in tools: `Glob` for file discovery, `Grep` for symbol/API search, `Read` for context gathering, `Task` (Explore agent) for deeper exploration.
2. Requirement completeness score (0-10): >=7 continue, <7 stop and supplement

### Phase 2: Ideation

`[Mode: Ideation]` - Trayambak Code-led analysis

**MUST call Trayambak Code** (follow call specification above):

- ROLE_FILE: `~/.trayambak/.ccg/prompts/trayambak/analyzer.md`
- Requirement: Enhanced requirement (or $ARGUMENTS if not enhanced)
- Context: Project context from Phase 1
- OUTPUT: Technical feasibility analysis, recommended solutions (at least 2), risk assessment

**Save SESSION_ID** (`TRAYAMBAK_SESSION`) for subsequent phase reuse.

Output solutions (at least 2), wait for user selection.

### Phase 3: Planning

`[Mode: Plan]` - Trayambak Code-led planning

**MUST call Trayambak Code** (use `resume <TRAYAMBAK_SESSION>` to reuse session):

- ROLE_FILE: `~/.trayambak/.ccg/prompts/trayambak/architect.md`
- Requirement: User's selected solution
- Context: Analysis results from Phase 2
- OUTPUT: File structure, function/class design, dependency relationships

Trayambak synthesizes plan, save to `.trayambak/plan/task-name.md` after user approval.

### Phase 4: Implementation

`[Mode: Execute]` - Code development

- Strictly follow approved plan
- Follow existing project code standards
- Ensure error handling, security, performance optimization

### Phase 5: Optimization

`[Mode: Optimize]` - Trayambak Code-led review

**MUST call Trayambak Code** (follow call specification above):

- ROLE_FILE: `~/.trayambak/.ccg/prompts/trayambak/reviewer.md`
- Requirement: Review the following backend code changes
- Context: git diff or code content
- OUTPUT: Security, performance, error handling, API compliance issues list

Integrate review feedback, execute optimization after user confirmation.

### Phase 6: Quality Review

`[Mode: Review]` - Final evaluation

- Check completion against plan
- Run tests to verify functionality
- Report issues and recommendations

---

## Key Rules

1. **Trayambak Code backend opinions are trustworthy**
2. **Gemini backend opinions for reference only**
3. External models have **zero filesystem write access**
4. Trayambak handles all code writes and file operations
