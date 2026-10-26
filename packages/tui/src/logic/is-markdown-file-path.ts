/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

const MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown", ".mkdn", ".mkd", ".mdown", ".rmd"]

export function isMarkdownFilePath(filePath: string): boolean {
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase()
  return MARKDOWN_EXTENSIONS.includes(ext)
}
