/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Shared types for the Trayambak Code UI TypeScript port.
 * Ported from Rust ratatui/crossterm structures in the Trayambak Code TUI.
 */

import { z } from "zod"

export type Primitive = "string" | "number" | "boolean"

export interface Session {
  id: string
}

export interface Model {
  id: string
  name: string
  maxTokens?: number
  supportsReasoning?: boolean
}

export type ToolCallMode = "none" | "auto" | "required"

export interface Approval {
  approved: boolean
  message?: string
}

export interface AppPreferences {
  model: Model
  autoAccept: boolean
  approveAllCommands: boolean
  showTips: boolean
  streamingGateEnabled: boolean
}

export interface AppCommand {
  name: string
  description: string
  confirmation?: string
  requiresArguments?: boolean
}

export type AppEvent =
  | { type: "configChanged"; preferences: AppPreferences }
  | { type: "modelSelected"; model: Model }
  | { type: "commandExecuted"; command: AppCommand }
  | { type: "sessionStarted"; session: Session }
  | { type: "sessionEnded"; session: Session }
  | { type: "toolCallStarted"; toolName: string; args: Record<string, unknown> }
  | { type: "toolCallCompleted"; toolName: string; result: string; error?: boolean }

export interface ToolResult {
  id: string
  tool: string
  content: string
  error?: boolean
  duration: number
}

export interface Feature {
  name: string
  enabled: boolean
  description?: string
}

export interface ProjectConfig {
  projectRoot: string
  model: Model
  features: Feature[]
  preferences: AppPreferences
}

export interface ProviderAuth {
  apiKey?: string
  baseURL?: string
}

export interface Provider {
  name: string
  models: Model[]
  auth?: ProviderAuth
}

export interface QuestionChoice {
  label: string
  value: string
  description?: string
}

export interface QuestionConfig {
  question: string
  choices: QuestionChoice[]
  multiple?: boolean
  default?: string | string[]
}

export interface NotebookCell {
  id: string
  cellType: "code" | "markdown"
  source: string
  executionCount?: number
  outputs?: NotebookOutput[]
}

export interface NotebookOutput {
  outputType: "stream" | "error" | "execute_result" | "display_data"
  data?: Record<string, unknown>
  text?: string
  executionCount?: number
}

export interface NotebookEditArgs {
  path: string
  cellId: string
  newSource: string
  cellType?: "code" | "markdown"
}

export interface PlanModeArgs {
  prompt: string
  plannerCallback?: string
}

export type ToolParameterPropertyType = "string" | "number" | "boolean" | "array" | "object" | "enum"

export interface ToolParameterProperty {
  type: ToolParameterPropertyType
  description?: string
  enum?: string[]
  items?: ToolParameterProperty
  required?: boolean
}

export interface ToolParameters {
  type: "object"
  properties: Record<string, ToolParameterProperty>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameters
  requiresArguments?: boolean
}

export type Role = "user" | "assistant" | "system"

export interface ChatMessage {
  role: Role
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  id: string
  type: "function"
  name: string
  arguments: Record<string, unknown>
}

export interface TokenCounter {
  input: number
  output: number
  total: number
  cache?: number
}

export interface SlashCommand {
  name: string
  description: string
  aliases?: string[]
  requiresAuth?: boolean
}

export interface StreamChunk {
  type: "text" | "tool_call" | "error"
  data: string
}

export interface StreamError {
  code: string
  message: string
}

export interface RenderedSegment {
  type: "text" | "tool-call" | "divider"
  text?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
}

export interface Shortcut {
  key: string
  description: string
  action: string
}

export interface LoginCredentials {
  username: string
  password: string
}

export interface LoginToken {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

export interface LoginResult {
  success: boolean
  token?: LoginToken
  error?: string
}

export type BottomPaneMode = "input" | "slash-menu" | "history" | "help"

export interface HistoryEntry {
  id: string
  command: string
  timestamp: number
  result?: string
}

export interface HelpEntry {
  command: string
  description: string
  example?: string
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

export type Nullable<T> = T | null

export type Status = "idle" | "loading" | "success" | "error"

export const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  maxTokens: z.number().optional(),
  supportsReasoning: z.boolean().optional(),
})

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
})

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
})

export const SlashCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  aliases: z.array(z.string()).optional(),
  requiresAuth: z.boolean().optional(),
})

export const HistoryEntrySchema = z.object({
  id: z.string(),
  command: z.string(),
  timestamp: z.number(),
  result: z.string().optional(),
})

export const LoginCredentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(8),
})

export const LoginTokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
})

export const LoginResultSchema = z.object({
  success: z.boolean(),
  token: LoginTokenSchema.optional(),
  error: z.string().optional(),
})

export const QuestionConfigSchema = z.object({
  question: z.string(),
  choices: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      description: z.string().optional(),
    }),
  ),
  multiple: z.boolean().optional(),
  default: z.union([z.string(), z.array(z.string())]).optional(),
})

export const NotebookOutputSchema = z.object({
  outputType: z.enum(["stream", "error", "execute_result", "display_data"]),
  data: z.record(z.string(), z.unknown()).optional(),
  text: z.string().optional(),
  executionCount: z.number().optional(),
})

export const NotebookCellSchema = z.object({
  id: z.string(),
  cellType: z.enum(["code", "markdown"]),
  source: z.string(),
  executionCount: z.number().optional(),
  outputs: z.array(NotebookOutputSchema).optional(),
})

export const NotebookEditArgsSchema = z.object({
  path: z.string(),
  cellId: z.string(),
  newSource: z.string(),
  cellType: z.enum(["code", "markdown"]).optional(),
})

export const PlanModeArgsSchema = z.object({
  prompt: z.string(),
  plannerCallback: z.string().optional(),
})

export const ToolParametersSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.any()),
  required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
})

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: ToolParametersSchema,
  requiresArguments: z.boolean().optional(),
})

export const SlashCommandListSchema = z.array(SlashCommandSchema)
