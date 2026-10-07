/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Tiny, safe-by-construction markdown renderer for assistant messages.
 *
 * Contract (matches the TUI): assistant text renders markdown, tool
 * results stay verbatim elsewhere. Input is HTML-ESCAPED before any tag
 * is built, so model output can never inject markup — links are limited
 * to http(s)/mailto. Fenced code is extracted before escaping and
 * restored afterwards (its content is escaped at extraction time).
 *
 * Plain browser file (loaded via <script src>) AND the unit-tested
 * source of truth: the test evaluates these exact bytes (see
 * markdown.test.ts), so the app and the test cannot drift.
 */

function trayambakEscapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function trayambakRenderMarkdown(source) {
  const text = String(source == null ? "" : source)

  // 1. Extract fenced code blocks (escaped immediately; placeholder
  //    tokens are NUL-digit-NUL and survive escaping untouched).
  const fences = []
  const withoutFences = text.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_match, code) => {
    const body = String(code).replace(/\n$/, "")
    fences.push('<pre class="code"><code>' + trayambakEscapeHtml(body) + "</code></pre>")
    return "\u0000" + (fences.length - 1) + "\u0000"
  })

  // 2. Escape everything else — no raw HTML from the model ever reaches
  //    the DOM.
  let out = trayambakEscapeHtml(withoutFences)

  // 3. Inline code (content already escaped).
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>")

  // 4. Inline emphasis.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>")
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")

  // 5. Links: only http(s) and mailto survive; anything else renders as
  //    literal (already-escaped) text.
  out = out.replace(/\[([^\]\n]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, (_match, label, href) => {
    return '<a href="' + href + '" target="_blank" rel="noreferrer noopener">' + label + "</a>"
  })

  // 6. Block structure, line by line.
  const lines = out.split("\n")
  const blocks = []
  let paragraph = []
  let listTag = null

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push("<p>" + paragraph.join("<br />") + "</p>")
      paragraph = []
    }
  }
  const closeList = () => {
    if (listTag !== null) {
      blocks.push("</" + listTag + ">")
      listTag = null
    }
  }

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line)
    const quote = /^\s*&gt;\s?(.*)$/.exec(line)
    const hr = /^\s*(?:-{3,}|\*{3,})\s*$/.exec(line)

    if (hr !== null) {
      flushParagraph()
      closeList()
      blocks.push("<hr />")
    } else if (heading !== null) {
      flushParagraph()
      closeList()
      const level = heading[1].length
      blocks.push("<h" + level + ">" + heading[2] + "</h" + level + ">")
    } else if (bullet !== null || ordered !== null) {
      flushParagraph()
      const tag = bullet !== null ? "ul" : "ol"
      if (listTag !== tag) {
        closeList()
        blocks.push("<" + tag + ">")
        listTag = tag
      }
      const body = bullet !== null ? bullet[1] : ordered[1]
      blocks.push("<li>" + body + "</li>")
    } else if (quote !== null) {
      flushParagraph()
      closeList()
      blocks.push("<blockquote>" + quote[1] + "</blockquote>")
    } else if (line.trim().length === 0) {
      flushParagraph()
      closeList()
    } else {
      closeList()
      paragraph.push(line)
    }
  }
  flushParagraph()
  closeList()

  // 7. Restore fenced code blocks in order of appearance. A fence sits on
  //    its own line, so its token line becomes a standalone block.
  let html = blocks.join("\n")
  html = html.replace(/<p>\u0000(\d+)\u0000<\/p>/g, (_m, index) => fences[Number(index)])
  html = html.replace(/\u0000(\d+)\u0000/g, (_m, index) => fences[Number(index)])

  return html
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { trayambakEscapeHtml, trayambakRenderMarkdown }
}
