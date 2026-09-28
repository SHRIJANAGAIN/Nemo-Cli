/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import * as http from "http"
import * as https from "https"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

export interface GeneratedAgent {
  identifier: string
  whenToUse: string
  systemPrompt: string
  tools?: string[]
  model?: string
}

const PROMPT_GENERATE = `You are an elite AI agent architect specializing in crafting high-performance agent configurations for the trayambak AI coding agent (by SKT AI LABS PRIVATE LIMITED). Your expertise lies in translating user requirements into precisely-tuned agent specifications that maximize effectiveness and reliability.

**Important Context**: You may have access to project-specific instructions from AGENTS.md, CLAUDE.md, CONTEXT.md files. Consider this context when creating agents to ensure they align with the project's established patterns and practices. For agents that review code, assume the user is asking to review recently written code, not the whole codebase, unless explicitly instructed otherwise.

When a user describes what they want an agent to do:

1. **Extract Core Intent**: Identify the fundamental purpose, key responsibilities, and success criteria.
2. **Design Expert Persona**: Create a compelling expert identity with deep domain knowledge.
3. **Architect Comprehensive Instructions**: System prompt with behavioral boundaries, methodologies, edge case handling, output format expectations.
4. **Optimize for Performance**: Include decision-making frameworks, quality control mechanisms, self-verification steps, efficient workflows, escalation strategies.
5. **Create Identifier**: Concise, descriptive, lowercase letters-numbers-hyphens, 2-4 words.

Output ONLY valid JSON:
{
  "identifier": "kebab-case-name (e.g., 'code-reviewer', 'api-docs-writer')",
  "whenToUse": "Precise, actionable description starting with 'Use this agent when...' defining trigger conditions and use cases.",
  "systemPrompt": "Complete system prompt governing agent behavior, second person ('You are...', 'You will..')"
}

Be specific rather than generic. Include concrete examples when helpful. Balance comprehensiveness with clarity.`

const definition: ToolDefinition = {
  name: "trayambak__GenerateAgent",
  description:
    "Generate a specialized subagent profile from a natural-language description. The generated agent is saved as a markdown file with frontmatter and can be referenced by name in subsequent agent calls. Creates an agent that can be invoked with specific roles and toolkits.",
  parameters: {
    type: "object",
    required: ["description"],
    properties: {
      description: {
        type: "string",
        description:
          "What the subagent should do — e.g., 'Review TypeScript code for security vulnerabilities and return a structured report'",
      },
      name: {
        type: "string",
        description: "Optional identifier for the agent. If omitted, one is derived from the description.",
      },
      tools: {
        type: "array",
        items: { type: "string", description: "Tool name to grant the agent" },
        description: "Optional list of tool names the agent should have access to.",
      },
      model: { type: "string", description: "Optional model override for this agent." },
    },
  },
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
}

async function callProvider(
  config: { baseUrl: string; apiKey: string; model: string },
  prompt: string,
): Promise<string> {
  const payload = JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: PROMPT_GENERATE },
      { role: "user", content: prompt },
    ],
    max_tokens: 2048,
    temperature: 0.3,
    top_p: 0.9,
  })

  const url = new URL(config.baseUrl)
  const lib = url.protocol === "https:" ? https : http

  const isNvidia = url.hostname.includes("nvidia") || url.hostname.includes("integrate.api")
  const endpoint = isNvidia ? "/v1/chat/completions" : "/chat/completions"
  const finalUrl = `${url.origin}${endpoint}`

  return new Promise((resolve, reject) => {
    const req = lib.request(
      finalUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 30_000,
      },
      (res: http.IncomingMessage) => {
        let buf = ""
        res.on("data", (c: Buffer) => (buf += c.toString()))
        res.on("end", () => {
          try {
            const json = JSON.parse(buf)
            if (json.choices?.[0]?.message?.content) {
              resolve(json.choices[0].message.content)
            } else if (json.choices?.[0]?.text) {
              resolve(json.choices[0].text)
            } else if (json.content) {
              resolve(json.content)
            } else {
              reject(new Error("Unexpected response format"))
            }
          } catch {
            reject(new Error(`Failed to parse response: ${buf.slice(0, 200)}`))
          }
        })
      },
    )
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

function saveAgentProfile(agent: GeneratedAgent, cwd: string): string {
  const agentsDir = path.join(cwd, ".trayambak", "agents")
  fs.mkdirSync(agentsDir, { recursive: true })
  const filePath = path.join(agentsDir, `${agent.identifier}.md`)

  const frontmatter: string[] = []
  frontmatter.push("---")
  frontmatter.push(`name: ${agent.identifier}`)
  frontmatter.push(`description: ${agent.whenToUse.replace(/\n/g, " ").slice(0, 200)}`)
  if (agent.model) frontmatter.push(`model: ${agent.model}`)
  if (agent.tools && agent.tools.length > 0) frontmatter.push(`tools: ${agent.tools.join(", ")}`)
  frontmatter.push("---")
  frontmatter.push("")

  const content = `${frontmatter.join("\n")}\n${agent.systemPrompt}\n`
  fs.writeFileSync(filePath, content, "utf8")
  return filePath
}

export function createGenerateAgentTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const description = String(args.description ?? "")
      const explicitName = String(args.name ?? "")
      const tools = args.tools as string[] | undefined
      const model = String(args.model ?? "")
      const cwd = context?.cwd ?? process.cwd()

      if (!description) return textResult("Missing 'description'.", true)

      const baseUrl = process.env.TRAYAMBAK_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "http://localhost:8080"
      const apiKey = process.env.TRAYAMBAK_API_KEY ?? process.env.OPENAI_API_KEY ?? ""
      const modelName = model || process.env.TRAYAMBAK_MODEL || "trayambak"

      try {
        const response = await callProvider({ baseUrl, apiKey, model: modelName }, description)

        let parsed: Partial<GeneratedAgent>
        try {
          const jsonMatch = response.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0])
          } else {
            parsed = JSON.parse(response)
          }
        } catch {
          return textResult(`Failed to parse agent generation response. Raw:\n${response.slice(0, 500)}`, true)
        }

        const agent: GeneratedAgent = {
          identifier: explicitName || slugify(parsed.identifier || description),
          whenToUse: parsed.whenToUse || description,
          systemPrompt: parsed.systemPrompt || "",
          tools: tools || parsed.tools,
          model: parsed.model || model,
        }

        const filePath = saveAgentProfile(agent, cwd)

        const summary = `Generated agent:
  Name: ${agent.identifier}
  File: ${filePath}
  Tools: ${(agent.tools || []).join(", ") || "default"}
  Model: ${agent.model || "default"}

Reference as: agent=${agent.identifier}`
        return textResult(summary)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return textResult(`Failed to generate agent: ${msg}`, true)
      }
    },
  }
}
