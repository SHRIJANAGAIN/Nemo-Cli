/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export interface AstValidationResult {
  valid: boolean
  undefinedVariables: string[]
  missingImports: string[]
  syntaxErrors: string[]
  newVariablesIntroduced: string[]
  newFunctions: string[]
}

export interface VariableScope {
  variables: Set<string>
  functions: Set<string>
  imports: Set<string>
}

export function extractPythonScope(source: string): VariableScope {
  const variables = new Set<string>()
  const functions = new Set<string>()
  const imports = new Set<string>()

  const varAssignRegex = /(\w+)\s*=/g
  let match
  while ((match = varAssignRegex.exec(source)) !== null) {
    if (match[1] && !match[1].startsWith("_")) {
      variables.add(match[1])
    }
  }

  const funcDefRegex = /def\s+(\w+)\s*\(/g
  while ((match = funcDefRegex.exec(source)) !== null) {
    functions.add(match[1])
  }

  const paramRegex = /def\s+\w+\s*\(([^)]*)\)/g
  while ((match = paramRegex.exec(source)) !== null) {
    if (match[1]) {
      match[1].split(",").forEach((param) => {
        const trimmed = param.trim().split(":")[0].split("=")[0].trim()
        if (trimmed && !trimmed.startsWith("_") && trimmed !== "self" && trimmed !== "cls") {
          variables.add(trimmed)
        }
      })
    }
  }

  const importRegex = /(?:from\s+(\S+)\s+)?import\s+([\w,]+)/g
  while ((match = importRegex.exec(source)) !== null) {
    if (match[2]) {
      match[2].split(",").forEach((imp) => {
        const trimmed = imp.trim()
        if (trimmed && !trimmed.startsWith("_")) {
          imports.add(trimmed)
        }
      })
    }
  }

  return { variables, functions, imports }
}

export function extractTypeScriptScope(source: string): VariableScope {
  const variables = new Set<string>()
  const functions = new Set<string>()
  const imports = new Set<string>()

  const varDeclRegex = /(?:const|let|var)\s+(\w+)/g
  let match
  while ((match = varDeclRegex.exec(source)) !== null) {
    if (match[1] && !match[1].startsWith("_")) {
      variables.add(match[1])
    }
  }

  const funcDefRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g
  while ((match = funcDefRegex.exec(source)) !== null) {
    functions.add(match[1])
  }

  const arrowFuncRegex = /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g
  while ((match = arrowFuncRegex.exec(source)) !== null) {
    functions.add(match[1])
  }

  const importRegex = /import\s+(?:{[^}]+}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g
  while ((match = importRegex.exec(source)) !== null) {
    if (match[0].includes("{")) {
      const braceMatch = match[0].match(/{([^}]+)}/)
      if (braceMatch) {
        braceMatch[1].split(",").forEach((imp) => {
          const trimmed = imp.trim().replace(" as ", "").trim()
          if (trimmed) imports.add(trimmed)
        })
      }
    }
  }

  return { variables, functions, imports }
}

export function validatePatch(
  originalSource: string,
  patchedSource: string,
  language: "python" | "typescript" | "javascript",
): AstValidationResult {
  const extractor = language === "python" ? extractPythonScope : extractTypeScriptScope
  const originalScope = extractor(originalSource)
  const patchedScope = extractor(patchedSource)

  const newVariables: string[] = []
  const newFunctions: string[] = []

  for (const v of patchedScope.variables) {
    if (!originalScope.variables.has(v)) {
      newVariables.push(v)
    }
  }
  for (const f of patchedScope.functions) {
    if (!originalScope.functions.has(f)) {
      newFunctions.push(f)
    }
  }

  return {
    valid: newVariables.length === 0 && newFunctions.length === 0,
    undefinedVariables: [],
    missingImports: [],
    syntaxErrors: [],
    newVariablesIntroduced: newVariables,
    newFunctions,
  }
}
