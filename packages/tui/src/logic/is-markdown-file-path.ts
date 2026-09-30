/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

const MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown", ".mkdn", ".mkd", ".mdown", ".rmd"]

export function isMarkdownFilePath(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase()
  return MARKDOWN_EXTENSIONS.includes(ext)
}
