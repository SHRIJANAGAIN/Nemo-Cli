/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The prompts that carry the method.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory. The prompt text IS the method: the engine
 * computes structure, the model reads evidence and decides. Two rules are
 * load-bearing and must not be softened:
 *
 * 1. The prompts never mention a rubric, a grader or a score. The method
 *    is ground-truth-free, and a prompt that leaks a grading signal
 *    turns refinement into fitting-to-the-answer.
 * 2. A decision without evidence attached is a decision the next reader
 *    cannot audit, so every note cites the moment that decided it.
 */

import type { HarnessProfile } from "./types.js"
import { NEMO_SURFACE } from "./tree.js"
import { CODING_AGENT_PROFILE } from "./profiles.js"

/** Render the editable layout for a surface, so the proposer knows what it may edit. */
export function harnessLayoutDescription(): string {
  const surface = NEMO_SURFACE
  return [
    "# THE HARNESS",
    "",
    `Always-on files (in injection order): ${surface.alwaysOn.join(", ")}`,
    `Skills: ${surface.skillDir}/<name>/SKILL.md`,
    `Subagents: ${surface.subagentDir}/<name>/AGENT.md`,
    `Helper scripts: ${surface.scriptDir}/<name>.mjs`,
    ...(surface.pluginDir === null ? [] : [`Plugins: ${surface.pluginDir}/<name>.mjs`]),
    "",
    "The always-on body is what every turn costs. Skills, subagents, scripts and plugins are",
    "loaded on demand, and each must be named in the always-on text to ever fire.",
  ].join("\n")
}

/** The dimension rules, kept apart so a candidate cannot straddle them. */
function dimensionRules(profile: HarnessProfile, dimension: "INV" | "DOM"): string {
  if (dimension === "INV") {
    return [
      "You own how the agent WORKS -- procedure, tool use, error handling, sequencing and",
      "completion discipline. You do not own subject matter. Trace the workflow, fix its",
      "earliest observed divergence, and match each failure to the cheapest effective component:",
      "  - TOOL ERROR: distinguish bad input from timeout, missing capability, permission, or an",
      "    unread result. Give one bounded fallback and a stop condition; never prescribe blind",
      "    repetition.",
      "  - MECHANICAL REPETITION: a deterministic helper script for repeated extraction.",
      "  - TRIGGERED WORKFLOW: a skill for a narrow multi-step procedure, with its trigger named",
      "    in the always-on text in the same edit.",
      "  - IGNORED INVARIANT: only repeated evidence that clear prose is skipped justifies a",
      "    defensive always-on rule.",
      "  - ORDINARY SEQUENCING: concise always-on guidance beats a longer script.",
      "",
      `The levers you may pull in this ${profile.domainWord}:`,
      profile.invLevers,
      "",
      `Do not add professional rules about the ${profile.deliverableWord}, required sections or`,
      "facts of the matter. Another candidate owns those; stay on how the agent works.",
    ].join("\n")
  }
  return [
    "You own what a practitioner of this area KNOWS -- the ask, the repository's own",
    "conventions, the controlling sources, compatibility promises, the shape of the change",
    "and its audience. You do not prescribe commands, retries, reading order, budgeting or",
    "scripts. Another candidate owns those; stay on what the work IS.",
    "",
    `The levers you may pull in this ${profile.domainWord}:`,
    profile.domLevers,
  ].join("\n")
}

/** The evidence boundary repeated in every prompt. */
const EVIDENCE_BOUNDARY = [
  "Every rollout you can see is on disk. Read it -- do not answer from this message alone.",
  "",
  "The trajectory was NOT clipped to fit this message: every event is present. An individual",
  "observation may carry an explicit truncation marker; that marker is ours, not behaviour by",
  "the agent, and it is not a failure to diagnose.",
  "",
  "Read the task and the current harness first. Inspect every rollout or candidate at least",
  "once before deciding. Cite the specific trajectory moment behind every change; one you",
  "cannot trace to a moment is speculation.",
].join("\n")

/** How to weigh the evidence. */
const WEIGH = [
  "How to weigh the evidence:",
  "",
  "- A failure that repeats across the base set is a real property of the base harness and the",
  "  strongest thing you can act on. A defect in 1 of many is noise, and an edit aimed at it is",
  "  overfitting to one sample.",
  "- Each candidate has ONE rollout, so a single good or bad outcome is weak evidence either",
  "  way. An edit earns its place when a SPECIFIC MOMENT in a trajectory shows the mechanism --",
  "  'this looks like good practice' is not evidence; name the moment.",
  "- Judge the downside as heavily as the upside. The costliest failure is a run that produces",
  "  nothing that applies; an edit that helps one rollout and risks emptiness elsewhere is bad.",
  "- If any rollout associated with an edit produced nothing, say so explicitly and treat that",
  "  edit as UNSAFE unless the rest of the evidence is overwhelming.",
].join("\n")

/** How to choose what to change. */
const HOW_TO_DECIDE = [
  "# HOW TO DECIDE WHAT TO CHANGE",
  "",
  "Every edit must trace to a moment in a trajectory. For each one ask: which run did what,",
  "and would this text have changed it? If you cannot name the moment, the edit is speculation",
  "and costs context for nothing. Prefer, in order:",
  "  1. a DIVERGENCE -- the runs disagreed, so the agent can already do it and just needs",
  "     telling. This is the cheapest win.",
  "  2. a repeated concrete failure -- the same error or omission in every run.",
  "  3. a risk visible in a trajectory but not yet realised.",
  "Do not fix what the runs already got right, and do not restate what the harness already says",
  "clearly; duplicated instruction dilutes the rest.",
].join("\n")

/** The edit contract: omitted-is-inherited, and how to say no. */
const EDIT_CONTRACT = [
  "# HOW TO MAKE A CHANGE",
  "",
  "The harness is yours to edit. Change the files under `context/harness/` in place; create a",
  "new one where a new component is the right lever. Your edits ARE the proposal -- there is no",
  "separate format to reproduce, and nothing you write in this reply changes the harness.",
  "",
  "- Files you do not touch are inherited unchanged. Do not rewrite a file to keep it the same.",
  "- Delete a file to remove that component.",
  "- If the evidence does not argue for any change, leave everything as it is and say KEEP_BASE",
  "  in your notes. That is a real answer, not a failure: adaptation the evidence does not",
  "  support costs context and buys nothing.",
  "",
  "Then reply with ONE <notes> block and nothing else: for each change, the moment in a",
  "trajectory that motivated it. The notes are read by a person, not applied by a machine.",
].join("\n")

/** The per-decision note format. */
const NOTE_FORMAT = [
  "In your single <notes> block, one line per decision, in this exact shape:",
  "",
  "    kept|revised|dropped -> <which edit> -> <the trajectory moment or base-set pattern",
  "    that decided it, with counts where sets are involved>",
  "",
  "A decision without evidence attached is a decision the next reader cannot audit.",
].join("\n")

/** The rules that bind every proposer, repeated so the composer inherits them. */
function surfaceRules(profile: HarnessProfile): string {
  return [
    "# THE RULES THAT BIND YOU",
    "",
    "1. Every skill needs a trigger line naming it verbatim in the always-on body, in the same",
    "   edit.",
    "2. No template braces in always-on text; the harness body is literal text.",
    "3. Every helper script you name must exist in the same edit.",
    `4. The always-on body has a hard cap of ${profile.alwaysOnMax.toLocaleString("en-US")} characters. Every token there competes with the agent's own output budget.`,
    "5. Deleting a file removes that component. Omitted files are inherited unchanged.",
    "6. Component names are lowercase letters, digits, `_` or `-`.",
  ].join("\n")
}

function generalise(profile: HarnessProfile): string {
  return [
    "# WHAT GENERALISES",
    "",
    `You are editing the harness for ONE task in this ${profile.domainWord}. The harness you`,
    `produce will run on this task, and if it is selected it enters the ${profile.domainWord}'s`,
    "library where later tasks read it. Write for the shape of situation, not for this task's",
    "facts: a rule that only makes sense with today's file names is a rule that misleads later.",
  ].join("\n")
}

/** A guard against grading vocabulary leaking into a prompt. */
export function assertPromptClean(text: string, profile: HarnessProfile): void {
  const lowered = text.toLowerCase()
  for (const word of profile.forbiddenPromptWords) {
    if (lowered.includes(word.toLowerCase())) {
      throw new Error(
        `the prompt leaked grading vocabulary (${JSON.stringify(word)}); the method is ` +
          "ground-truth-free and a prompt that names a score turns refinement into fitting",
      )
    }
  }
}

/** The mission for one INV or DOM candidate. `round` set means sequential mode. */
export function proposePrompt(input: {
  dimension: "INV" | "DOM"
  k: number
  index: number
  round: number | null
  profile?: HarnessProfile
}): string {
  const profile = input.profile ?? CODING_AGENT_PROFILE
  const where =
    input.k > 1
      ? [
          `You are candidate ${input.index} of ${input.k} on this dimension, drawn independently`,
          "from the same evidence and never shown the others.",
        ].join("\n")
      : ""
  const roundNote =
    input.round === null
      ? ""
      : [
          `This is round ${input.round} of ${input.k}. You are editing the checkpoint the previous`,
          "round produced, not the original harness, and the evidence includes every earlier",
          "round. In this stage `KEEP_BASE` means leave that CURRENT checkpoint unchanged; it",
          "never resets to the original harness.",
        ].join("\n")
  const parts = [
    `You are the ${input.dimension === "INV" ? "INVARIANT" : "DOMAIN"} harness editor for one`,
    `task in this ${profile.domainWord}. You have the current real task, full rollouts of it`,
    "under the current harness, the current harness files, and this area's library of what was",
    "adopted for earlier tasks.",
    `# THE WORK\n\n${profile.work}`,
    dimensionRules(profile, input.dimension),
    generalise(profile),
    HOW_TO_DECIDE,
    where,
    roundNote,
    "Do not hedge toward an average or try to cover every base -- commit to the single most",
    "defensible version of your dimension. A later stage compares and merges.",
    EVIDENCE_BOUNDARY,
    harnessLayoutDescription(),
    surfaceRules(profile),
    EDIT_CONTRACT,
    NOTE_FORMAT,
  ]
  const text = tidy(parts)
  assertPromptClean(text, profile)
  return text
}

/** The mission for a parallel composition: one final from the whole pool. */
export function aggregatePrompt(input: {
  k: number
  index: number
  profile?: HarnessProfile
}): string {
  const profile = input.profile ?? CODING_AGENT_PROFILE
  const parts = [
    "You are composing THE final harness for one piece of work. What you emit is what gets",
    "ADOPTED: it runs on this task, and if selected it enters this area's library where later",
    "tasks read it. Every rule that bound the candidate proposers binds you -- you are the last",
    "gate, and merging an edit launders it.",
    `# THE WORK\n\n${profile.work}`,
    "# WHAT YOU HAVE\n",
    `${input.k} rollout(s) under the unmodified harness, and ${2 * input.k} candidate harnesses`,
    `-- ${input.k} on the INV dimension (how the agent works) and ${input.k} on the DOM`,
    "dimension (what a practitioner knows). Each candidate was rolled out ONCE and you have",
    "that rollout. The candidates were sampled separately but share the same task and likely",
    "model biases. Agreement is support, not independent proof; contradiction is a reason to",
    "read the trajectories, not a reason to discard either side.",
    [
      "# YOUR JOB",
      "",
      "1. Judge each candidate edit from the evidence: did its rollout show it helped, hurt, or",
      "   do nothing versus the base rollouts? The user's request is the yardstick -- completeness",
      "   against what was asked counts as much as correctness of what was produced. An edit",
      "   whose skill was never loaded or whose rule was ignored changed nothing, whatever it",
      "   says on paper.",
      "2. Synthesize ONE final harness containing only what the evidence supports: merge the good",
      "   parts of both dimensions, resolve overlaps rather than concatenating, keep always-on",
      "   text tiny, and keep every retained skill's trigger line narrow. Adopting a single",
      "   candidate wholesale is valid when it is simply the best state.",
      "",
      "KEEPING THE BASE UNCHANGED IS A VALID OUTCOME -- if no candidate demonstrably improved on",
      "base, leave the tree as it is and say KEEP_BASE in your notes.",
    ].join("\n"),
    input.k > 1
      ? [
          `You are one of ${input.k} composers working from this same evidence in parallel, and`,
          "you will not see the others. Do not aim for the consensus answer -- commit to the",
          "harness you can defend.",
        ].join("\n")
      : "",
    EVIDENCE_BOUNDARY,
    WEIGH,
    harnessLayoutDescription(),
    surfaceRules(profile),
    EDIT_CONTRACT,
    NOTE_FORMAT,
  ]
  const text = tidy(parts)
  assertPromptClean(text, profile)
  return text
}

/** The mission for a sequential round composition. */
export function composeRoundPrompt(input: {
  k: number
  round: number
  profile?: HarnessProfile
}): string {
  const profile = input.profile ?? CODING_AGENT_PROFILE
  const parts = [
    `Compose the harness for round ${input.round} of ${input.k}.`,
    `# THE WORK\n\n${profile.work}`,
    [
      "# YOUR JOB",
      "",
      "All of these are valid, judged only on what the rollouts support:",
      "- MERGE across rounds -- including a candidate REJECTED earlier, if a later rollout now",
      "  argues for it.",
      "- REPRODUCE an earlier checkpoint verbatim, if that state was simply the best one and",
      "  later rounds drifted away from it.",
      "- ADOPT this round's best candidate.",
      "- KEEP_BASE -- which here means keep the CURRENT checkpoint unchanged. It does not restore",
      "  the original harness.",
    ].join("\n"),
    EVIDENCE_BOUNDARY,
    WEIGH,
    harnessLayoutDescription(),
    surfaceRules(profile),
    EDIT_CONTRACT,
    NOTE_FORMAT,
  ]
  const text = tidy(parts)
  assertPromptClean(text, profile)
  return text
}

/** The mission for the blind selector. */
export function selectPrompt(input: {
  n: number
  evidence: "deliverable" | "trajectory"
  profile?: HarnessProfile
}): string {
  const profile = input.profile ?? CODING_AGENT_PROFILE
  const parts = [
    `You are choosing which of ${input.n} candidate ${profile.deliverableWord}s should be`,
    `delivered to the person who asked for this work.`,
    `# THE WORK\n\n${profile.work}`,
    [
      "# WHAT YOU ARE LOOKING AT",
      "",
      "Each candidate is what one agent run produced for the SAME request, in full.",
      "",
      "    context/task.md               the request, verbatim",
      "    context/source/               the material the work was done from",
      "    context/candidates/<id>.md    what that run PRODUCED, rendered",
      "",
      "You are choosing between ARTIFACTS. You are not told how any of them was produced and you",
      "cannot see the runs that made them, so judge each one on what it is, against the request",
      "and the source -- never on how impressive or thorough it sounds.",
    ].join("\n"),
    [
      "# HOW TO DECIDE, IN THIS ORDER",
      "",
      "1. DELIVERY. Is every part of the request present, in the requested form? Count what the",
      "   request explicitly asks to be produced, changed, explained or verified, and prefer the",
      "   candidate that answers the most of those points.",
      "",
      "2. CORRECTNESS. Do the claims hold up against the source and the repository? Where",
      "   candidates disagree, check `context/source/` and prefer the one whose derivation the",
      "   material supports. Reject invented specifics; where the source is silent, a candidate",
      "   that says so is safer than one that fills the gap confidently.",
      "",
      "3. CONFORMANCE. Is it ONLY what was asked for -- no drive-by rewrites, no renamed public",
      "   APIs, no unrequested refactors?",
      "",
      "4. CONSISTENCY. Does the artifact agree with itself -- counts matching their components,",
      "   file names matching their references, comments matching the code?",
      "",
      "5. OPERATIONAL FITNESS. Can the intended person or system actually use it? Does it build,",
      "   parse or run as the request requires?",
      "",
      "6. FINISH. No placeholders, no TODOs, no empty required fields, no unresolved notes.",
      "",
      "Length and polish are not merits in themselves. The candidates are independent attempts of",
      "differing quality, better than each other in different respects, and the plainest one may",
      "be the best answer. Pick the best available answer, not the most elaborate one.",
    ].join("\n"),
    `The evidence you are judging is the ${input.evidence} of each candidate.`,
    "Reply with exactly this shape:",
    "",
    "<why>",
    "At most 6 lines. Name the criterion that decided it, and the closest runner-up with the",
    "specific thing that cost it the pick.",
    "</why>",
    "",
    "```choice",
    "<the id of the single candidate to submit>",
    "```",
  ]
  const text = tidy(parts)
  assertPromptClean(text, profile)
  return text
}

/** The mission for the adoption reflection. */
export function experiencePrompt(input: {
  chosenLabel: string
  why: string
  profile?: HarnessProfile
}): string {
  const profile = input.profile ?? CODING_AGENT_PROFILE
  const parts = [
    `Harness ${input.chosenLabel} was adopted. The selection reasoning was:`,
    "",
    input.why || "(no reasoning was recorded)",
    "",
    [
      "Selection compared the OUTPUTS with the harnesses hidden, so the choice says which output",
      "read best -- not which edit worked. Treat every candidate as evidence. An edit that",
      "appeared only in a rejected candidate may still be the one that changed behaviour for the",
      "better, and an edit inside the adopted candidate may have contributed nothing to why it",
      "was adopted.",
      "",
      "Write at most ONE durable entry, and only if the edit rows support it.",
      "",
      "Reply with exactly this shape:",
      "",
      "<edits>",
      "component: <name as it appears in the harness>",
      "candidates: <the labels that carried this edit>",
      "change: <what the edit did>",
      "observed: <the execution difference, and where you saw it>",
      "verdict: <helped|hurt|no observed effect|confounded>",
      "(repeat those five lines for each changed component)",
      "</edits>",
      "",
      "<experience>",
      "cue: <the shape of situation this applies to -- the PATTERN, not this task's facts>",
      "lesson: <the transferable operation, naming the component it concerns>",
      "evidence: <the edit rows this rests on, and the execution contrast>",
      "confidence: <high|medium|low, and why>",
      "</experience>",
      "",
      "A lesson resting only on 'confounded' rows is a guess: narrow it to what the record does",
      "show, or decline. Adoption alone never establishes that an edit helped or will transfer.",
      "If the record shows no concrete, reusable execution contrast, write the single line",
      "NO_ENTRY in place of the <experience> block -- the edit rows are still worth writing.",
      "",
      "Prefer 'confounded' whenever one candidate changed several components at once and no",
      "execution isolates one of them, or when a single rollout is all that stands behind the",
      "difference. A confounded row is a useful record; an invented attribution poisons the",
      "library for every later task.",
    ].join("\n"),
    `# THE WORK\n\n${profile.work}`,
  ]
  const text = tidy(parts)
  assertPromptClean(text, profile)
  return text
}

function tidy(parts: readonly string[]): string {
  return (
    parts
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  )
}
