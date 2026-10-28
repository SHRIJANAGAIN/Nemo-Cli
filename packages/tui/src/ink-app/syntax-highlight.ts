/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React from "react"

interface StyleProps {
  color?: string
  fontWeight?: string | number
  fontStyle?: string
}

interface TextSpan {
  children: string
  style?: StyleProps
}

const BASH_KEYWORDS = [
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "return",
  "break",
  "continue",
  "exit",
  "local",
  "declare",
  "export",
  "readonly",
  "unset",
  "source",
  ".",
  "test",
  "[[",
  "]",
  "]",
  "&&",
  "||",
  ";",
  "|",
  "&",
  ">",
  "<",
  ">>",
  "<<",
  "echo",
  "printf",
  "cat",
  "ls",
  "cd",
  "pwd",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "grep",
  "sed",
  "awk",
  "find",
  "xargs",
  "sort",
  "uniq",
  "head",
  "tail",
  "wc",
  "cut",
  "tr",
  "tee",
  "curl",
  "wget",
  "git",
  "npm",
  "node",
  "python",
  "python3",
  "pip",
  "pip3",
  "cargo",
  "go",
  "rustc",
  "javac",
  "java",
  "make",
  "cmake",
  "docker",
  "kubectl",
  "ssh",
  "scp",
  "rsync",
  "tar",
  "gzip",
  "gunzip",
  "zip",
  "unzip",
  "chmod",
  "chown",
  "sudo",
  "su",
  "systemctl",
  "service",
  "journalctl",
  "dmesg",
  "df",
  "du",
  "free",
  "top",
  "htop",
  "ps",
  "kill",
  "pkill",
  "jobs",
  "fg",
  "bg",
  "nohup",
]

const BASH_BUILTINS = [
  "cd",
  "pwd",
  "echo",
  "printf",
  "read",
  "export",
  "unset",
  "alias",
  "unalias",
  "type",
  "which",
  "hash",
  "help",
  "history",
  "pushd",
  "popd",
  "dirs",
  "set",
  "shopt",
  "declare",
  "local",
  "readonly",
  "export",
  "source",
  ".",
  "exec",
  "eval",
  "trap",
  "exit",
  "return",
  "break",
  "continue",
  "shift",
  "getopts",
  "ulimit",
  "umask",
  "wait",
  "jobs",
  "fg",
  "bg",
  "disown",
  "command",
  "builtin",
  "enable",
  "logout",
  "times",
  "pwd",
]

function tokenizeBash(script: string): Array<{ type: string; text: string }> {
  const tokens: Array<{ type: string; text: string }> = []
  let i = 0
  let currentToken = ""
  let inSingleQuote = false
  let inDoubleQuote = false
  let inDollarParen = false
  let inCommandSub = false
  let inParamExpansion = false
  let braceDepth = 0

  while (i < script.length) {
    const char = script[i]
    const nextChar = script[i + 1] || ""

    if (inSingleQuote) {
      currentToken += char
      if (char === "'") {
        inSingleQuote = false
      }
      i++
      continue
    }

    if (inDoubleQuote) {
      currentToken += char
      if (char === '"' && script[i - 1] !== "\\") {
        inDoubleQuote = false
      } else if (char === "$" && nextChar === "(") {
        inCommandSub = true
      } else if (char === "$" && nextChar === "{") {
        inParamExpansion = true
        braceDepth = 1
      }
      i++
      continue
    }

    if (inCommandSub) {
      currentToken += char
      if (char === "(") {
        inDollarParen = true
      } else if (char === ")") {
        if (inDollarParen) {
          inDollarParen = false
        } else {
          inCommandSub = false
        }
      }
      i++
      continue
    }

    if (inParamExpansion) {
      currentToken += char
      if (char === "{") {
        braceDepth++
      } else if (char === "}") {
        braceDepth--
        if (braceDepth === 0) {
          inParamExpansion = false
        }
      }
      i++
      continue
    }

    if (char === "'") {
      if (currentToken) {
        tokens.push({ type: "plain", text: currentToken })
        currentToken = ""
      }
      inSingleQuote = true
      currentToken += char
      i++
      continue
    }

    if (char === '"') {
      if (currentToken) {
        tokens.push({ type: "plain", text: currentToken })
        currentToken = ""
      }
      inDoubleQuote = true
      currentToken += char
      i++
      continue
    }

    if (char === "$" && nextChar === "(") {
      if (currentToken) {
        tokens.push({ type: "plain", text: currentToken })
        currentToken = ""
      }
      inCommandSub = true
      currentToken += char + nextChar
      i += 2
      continue
    }

    if (char === "$" && nextChar === "{") {
      if (currentToken) {
        tokens.push({ type: "plain", text: currentToken })
        currentToken = ""
      }
      inParamExpansion = true
      braceDepth = 1
      currentToken += char + nextChar
      i += 2
      continue
    }

    if (char === "$" && /[A-Za-z0-9_]/.test(nextChar)) {
      currentToken += char
      i++
      continue
    }

    if (char === "`") {
      if (currentToken) {
        tokens.push({ type: "plain", text: currentToken })
        currentToken = ""
      }
      currentToken += char
      i++
      while (i < script.length && script[i] !== "`") {
        currentToken += script[i]
        i++
      }
      if (i < script.length) {
        currentToken += "`"
        i++
      }
      tokens.push({ type: "command-sub", text: currentToken })
      currentToken = ""
      continue
    }

    if (/\s/.test(char)) {
      if (currentToken) {
        tokens.push({ type: "plain", text: currentToken })
        currentToken = ""
      }
      tokens.push({ type: "whitespace", text: char })
      i++
      continue
    }

    if ("|&;<>()".includes(char)) {
      if (currentToken) {
        tokens.push({ type: "plain", text: currentToken })
        currentToken = ""
      }
      if (char === "&" && nextChar === "&") {
        tokens.push({ type: "operator", text: "&&" })
        i += 2
      } else if (char === "|" && nextChar === "|") {
        tokens.push({ type: "operator", text: "||" })
        i += 2
      } else if (char === ">" && nextChar === ">") {
        tokens.push({ type: "redirect", text: ">>" })
        i += 2
      } else if (char === "<" && nextChar === "<") {
        tokens.push({ type: "redirect", text: "<<" })
        i += 2
      } else if (char === ">" && nextChar === "&") {
        tokens.push({ type: "redirect", text: ">&" })
        i += 2
      } else if (char === "<" && nextChar === "&") {
        tokens.push({ type: "redirect", text: "<&" })
        i += 2
      } else {
        tokens.push({ type: "operator", text: char })
        i++
      }
      continue
    }

    currentToken += char
    i++
  }

  if (currentToken) {
    tokens.push({ type: "plain", text: currentToken })
  }

  return tokens
}

function classifyToken(token: string): string {
  if (/^[|&;<>()]$/.test(token) || token === "&&" || token === "||") {
    return "operator"
  }
  if (/^>?>?&?$/.test(token) || /^<<?&?$/.test(token)) {
    return "redirect"
  }
  if (/^\$\{/.test(token) || /^\$\(/.test(token) || /^`.*`$/.test(token)) {
    return "variable"
  }
  if (/^\$[A-Za-z0-9_]+$/.test(token)) {
    return "variable"
  }
  if (/^['"].*['"]$/.test(token)) {
    return "string"
  }
  if (/^-?\d+$/.test(token)) {
    return "number"
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
    return "assignment"
  }

  const lower = token.toLowerCase()
  if (BASH_KEYWORDS.includes(lower)) {
    return "keyword"
  }
  if (BASH_BUILTINS.includes(lower)) {
    return "builtin"
  }

  return "command"
}

/** Theme-driven bash colors. All fields optional — anything missing falls
 *  back to DEFAULT_BASH_PALETTE, so partial themes and old callers keep
 *  working. Mapping onto the 6 syntax tokens the Ink theme snapshot
 *  carries: keyword→syntaxKeyword, builtin→syntaxFunction,
 *  command→syntaxType, string→syntaxString, number→syntaxNumber,
 *  comment→syntaxComment (italic kept). Operator/redirect/variable/
 *  assignment stay on defaults (no matching theme tokens exist). */
export interface BashPalette {
  keyword?: string
  builtin?: string
  command?: string
  string?: string
  variable?: string
  number?: string
  operator?: string
  redirect?: string
  assignment?: string
  comment?: string
}

const DEFAULT_BASH_PALETTE: Required<BashPalette> = {
  keyword: "#c792ea",
  builtin: "#82aaff",
  command: "#c3e88d",
  string: "#ffcb6b",
  variable: "#f78c6c",
  number: "#ff5370",
  operator: "#89ddff",
  redirect: "#ff9248",
  assignment: "#ffcb6b",
  comment: "#546e7a",
}

function getStyleForType(type: string, palette: BashPalette = {}): Partial<React.CSSProperties> {
  const p = { ...DEFAULT_BASH_PALETTE, ...palette }
  switch (type) {
    case "keyword":
      return { color: p.keyword, fontWeight: "bold" }
    case "builtin":
      return { color: p.builtin, fontWeight: "bold" }
    case "command":
      return { color: p.command }
    case "string":
      return { color: p.string }
    case "variable":
      return { color: p.variable }
    case "number":
      return { color: p.number }
    case "operator":
      return { color: p.operator }
    case "redirect":
      return { color: p.redirect }
    case "assignment":
      return { color: p.assignment }
    case "comment":
      return { color: p.comment, fontStyle: "italic" }
    default:
      return {}
  }
}

export function highlightBash(script: string, palette?: BashPalette): TextSpan[] {
  const tokens = tokenizeBash(script)
  const spans: TextSpan[] = []

  for (const token of tokens) {
    if (token.type === "whitespace") {
      spans.push({ children: token.text })
    } else if (token.type === "plain") {
      const classification = classifyToken(token.text)
      const style = getStyleForType(classification, palette)
      spans.push({ children: token.text, style })
    } else {
      spans.push({ children: token.text })
    }
  }

  return spans
}

export function highlightBashToLines(script: string, palette?: BashPalette): Array<{ spans: TextSpan[] }> {
  const lines = script.split("\n")
  return lines.map((line) => ({
    spans: highlightBash(line, palette),
  }))
}
