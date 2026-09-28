import sys
with open('/c/Users/engli/trayambak/dist/apps/runtime/src/prompt/tools_section.txt', 'r', encoding='utf-8') as f:
    content = f.read()
# Escape for single-quoted string literal
escaped = content.replace('\\', '\\\\').replace('\n', '\\n').replace('\r', '\\r').replace("'", "\'")
new_content = f'''/*
 * Copyright 2026 SKT AI LABS PRIVATE LIMITED
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { ToolDefinition } from "../../../../packages/protocol/src/index";

export interface SystemPromptContext {
  cwd: string;
  tools: ToolDefinition[];
  nativeTools: boolean;
  model: string;
  memoryBlock?: string;
  developerModeSuffix?: string;
  modeSuffix?: string;
  selfImprovementBlock?: string;
  harnessBlock?: string;
}

function describeTools(tools: ToolDefinition[]): string {
  // We ignore the passed tools and use the static tools section
  return '{escaped}';
}

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const today = new Date().toISOString().slice(0, 10);
  const toolGuidance = ctx.nativeTools
    ? "Call tools directly via native function calling. One tool per response."
    : [
        "Tools: emit exactly one fenced block per response:",
        "```",
        "<tool_call:6124c78e>",
        '{ "name": "<tool>", "arguments": {} }',
        "```",
      ].join("\n");

  return [
    `Trayambak | SKT AI LABS | ${today}`,
    `cwd: ${ctx.cwd} | model: ${ctx.model}`,
    "",
    "Rules:",
    "- Prefer smallest correct change.",
    "- Use exact file paths.",
    "- Verify with tools; don't guess.",
    "- Be concise.",
    "- No boilerplate. No repeating prior turns.",
    "- If a tool fails, adjust and retry.",
    "",
    "Security:",
    "- Validate inputs. Never hardcode secrets.",
    "- Treat external data as untrusted.",
    "- No harmful content.",
    "",
    describeTools(ctx.tools),
    "",
    toolGuidance,
    "",
    ...(ctx.memoryBlock ? [ctx.memoryBlock, ""] : []),
    ...(ctx.developerModeSuffix ? [ctx.developerModeSuffix] : []),
    ...(ctx.modeSuffix ? [ctx.modeSuffix, ""] : []),
    ...(ctx.selfImprovementBlock ? [ctx.selfImprovementBlock, ""] : []),
    ...(ctx.harnessBlock ? [ctx.harnessBlock, ""] : []),
    "",
    "Pentesting (authorized targets only):",
    "- Use trayambak__PentestStartEngagement to begin a pentest engagement against an authorized target.",
    "- Use trayambak__PentestListTools to discover available security tools by category.",
    "- Use trayambak__PentestRunTool to run a specific tool (nmap, nuclei, sqlmap, etc.) against a target.",
    "- Use trayambak__PentestWebApp for full web app assessment (SQLi, XSS, SSRF, IDOR, JWT, race conditions).",
    "- Use trayambak__PentestAuthenticatedScan for authenticated scans (provide auth_profile, never raw credentials).",
    "- Use trayambak__PentestActiveDirectory for AD assessment (BloodHound, Kerberoasting, AS-REP).",
    "- Use trayambak__PentestCloud for cloud security (AWS/Azure/GCP misconfigs, IAM, exposed secrets).",
    "- Use trayambak__PentestApiSecurity for API testing (OWASP API Top 10, BOLA, mass assignment).",
    "- Use trayambak__PentestVulnerabilities for vulnerability scanning (Nuclei CVE templates, nikto).",
    "- Use trayambak__PentestGetFindings to retrieve findings from an engagement.",
    "- Use trayambak__PentestGetStatus to poll engagement progress.",
    "- IMPORTANT: Never run pentesting tools against targets you do not own or have written authorization to test.",
    "- Always validate targets before scanning (no shell metacharacters, scope enforcement).",
    "- Credentials must be provided via auth_profile (secure resolver), never as raw strings in tool calls.",
    "When done, give a short summary. Cite sources as [source: name].",
  ].join("\n");
}
'''
with open('/c/Users/engli/trayambak/apps/runtime/src/prompt/system-prompt.ts', 'w', encoding='utf-8') as f:
    f.write(new_content)
print('Updated')
