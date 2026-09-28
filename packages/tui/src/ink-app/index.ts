/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export { TrayambakApp, type TrayambakAppProps, renderTrayambakApp } from "./App.js"
export { TrayambakLogo, type TrayambakLogoProps } from "./TrayambakLogo.js"
export { MessageList, type MessageListProps } from "./MessageList.js"
export { MessageRow, type MessageRowProps } from "./MessageRow.js"
export { MessageResponse } from "./MessageResponse.js"
export { ToolCallItem, type ToolCallItemProps } from "./ToolCallItem.js"
export { MCPToolCallItem, type MCPToolCallItemProps } from "./MCPToolCallItem.js"
export { ExecToolCallItem, type ExecToolCallItemProps } from "./ExecToolCallItem.js"
export { ToolUseLoader, type ToolUseLoaderProps } from "./ToolUseLoader.js"
export { Spinner, type SpinnerProps } from "./Spinner.js"
export { GroupedToolUseContent, type GroupedToolUseProps } from "./GroupedToolUseContent.js"
export { UserToolResultMessage } from "./UserToolResultMessage/UserToolResultMessage.js"
export { UserToolSuccessMessage } from "./UserToolResultMessage/UserToolSuccessMessage.js"
export { UserToolErrorMessage } from "./UserToolResultMessage/UserToolErrorMessage.js"
export { UserToolRejectMessage } from "./UserToolResultMessage/UserToolRejectMessage.js"
export { UserToolCanceledMessage } from "./UserToolResultMessage/UserToolCanceledMessage.js"
export { PromptInput, type PromptInputProps } from "./PromptInput.js"
export { PermissionOverlay, type PermissionOverlayProps } from "./PermissionOverlay.js"
export { Footer, type FooterProps } from "./Footer.js"
export { SessionPicker, type SessionPickerProps } from "./SessionPicker.js"
export { SubagentPanel, type SubagentPanelProps } from "./SubagentPanel.js"
export { AgentPicker, type AgentPickerProps } from "./AgentPicker.js"
export { SubagentRow, type SubagentRowProps } from "./SubagentRow.js"

export type {
  PermissionMode,
  TrayambakMessage,
  MessagePart,
  ToolCallDisplay,
  ToolCallStatus,
  ToolCallRenderMode,
  SlashCommand,
  PermissionRequest,
  AppStatus,
  StatusBarInfo,
} from "./types.js"

export { PERMISSION_MODE_LABELS, STATUS_LABELS, SLASH_COMMANDS } from "./types.js"

export {
  createSubagentCard,
  finalizeSubagentCard,
  applyChildToolEvent,
  buildSubagentRows,
  mergeAgentOptions,
  BUILTIN_AGENT_OPTIONS,
  subagentCardId,
  type SubagentCardStart,
  type SubagentOutcome,
  type SubagentRouting,
  type SubagentPanelRow,
  type AgentOption,
} from "./subagent-view.js"

export {
  buildTerminalTitle,
  notifyTerminalActivity,
  type TerminalActivity,
  type TerminalTitleParts,
} from "./terminal-notify.js"

export { highlightBash, highlightBashToLines } from "./syntax-highlight.js"
