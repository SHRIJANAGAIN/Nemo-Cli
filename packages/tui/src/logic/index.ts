/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

export { cn } from "./utils"
// PENDING PORT — the original web UI's utils surface listed 34 more names
// below that were NEVER ported into this tree (they exist nowhere in the
// repo). They used to be live `export {}` lines, which made the entire
// tree uncompilable once logic/ became a checked program — kept as a
// manifest until someone ports them for real:
//   downloadBlob, getStyleHeightPx, setStyleHeightPx, isMobileDevice,
//   isProductionDomain, removeUnwantedKeys, getFileExtension,
//   shouldUseInstallationRepos, getGitProviderBaseUrl, getProviderName,
//   getPR, getPRShort, constructPullRequestUrl, constructRepositoryUrl,
//   constructBranchUrl, getGitCommitPrompt, getGitPullPrompt, getGitPushPrompt,
//   getCreatePRPrompt, getPushToPRPrompt, getCreateNewBranchPrompt,
//   getTotalTaskCount, getLimitedTaskGroups, getDisplayedTaskGroups,
//   getConversationStatusLabel, getStatusIcon, getStatusClassName,
//   shouldIncludeRepository, getOpenHandsQuery, hasOpenHandsSuffix,
//   buildSessionHeaders, isTaskPolling, getStatusColor, getStatusText
//   (+ the ConversationTab type re-exported with useHandlePlanClick below)
export {
  formControlButtonClassName,
  formControlHeightClassName,
  formControlFieldClassName,
  formControlShellClassName,
} from "./form-control-classes"
export {
  dropdownTriggerShellClassName,
  dropdownMenuListClassName,
  dropdownMenuListGapClassName,
  dropdownMenuRowClassName,
  dropdownMenuRowIconWrapperClassName,
} from "./dropdown-classes"
export {
  readScrollFadeState,
  type ScrollFadeState,
  type ScrollFadeState as ScrollFadeStateType,
} from "./scroll-fade-state"
export { isMarkdownFilePath } from "./is-markdown-file-path"
export { getAgentCanvasBasePath, buildAgentCanvasPath } from "./base-path"
export { useScrollToBottom } from "./use-scroll-to-bottom"
// ConversationTab (type) never existed in this tree — see the manifest above.
export { useHandlePlanClick } from "./use-handle-plan-click"
export { useHandleBuildPlanClick } from "./use-handle-build-plan-click"
export { useSelectConversationTab } from "./use-select-conversation-tab"
export { I18nKey } from "./i18n-declaration"
export { OH_STATUS_SUCCESS_COLOR, OH_STATUS_ERROR_COLOR } from "./status-colors"
