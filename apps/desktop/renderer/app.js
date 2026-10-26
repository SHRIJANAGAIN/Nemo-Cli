/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Nemo desktop chat UI. Talks ONLY through the preload bridge
 * (`window.nemo`) — no Node, no raw IPC. Rendering contract: user
 * input and assistant text go through the markdown renderer; tool
 * output is appended verbatim inside <pre> (never markdown).
 */
(function () {
  "use strict"

  var api = window.nemo
  var log = document.getElementById("log")
  var input = document.getElementById("input")
  var sendBtn = document.getElementById("send")
  var stopBtn = document.getElementById("stop")
  var statusEl = document.getElementById("status")
  var workspaceEl = document.getElementById("workspace")
  var folderBtn = document.getElementById("folder")

  /** Current streaming blocks (a tool event closes them). */
  var textBlock = null // { el, acc }
  var thoughtBlock = null // { el, acc }
  /** toolCallId → { el, name } for in-flight tool chips. */
  var tools = {}
  var busy = false

  function setStatus(state, label) {
    statusEl.dataset.state = state
    statusEl.textContent = label
  }

  function setBusy(next) {
    busy = next
    sendBtn.disabled = next
    stopBtn.disabled = !next
    input.disabled = false
    if (next) setStatus("busy", "working…")
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight
  }

  function closeStreams() {
    textBlock = null
    thoughtBlock = null
  }

  function appendUser(text) {
    var el = document.createElement("div")
    el.className = "msg user"
    el.textContent = text
    log.appendChild(el)
    closeStreams()
    scrollToEnd()
  }

  function appendText(text) {
    if (textBlock === null) {
      var el = document.createElement("div")
      el.className = "msg assistant"
      log.appendChild(el)
      textBlock = { el: el, acc: "" }
    }
    textBlock.acc += text
    // Re-render the whole turn from markdown source on every delta —
    // incremental HTML splicing would break code fences mid-stream.
    textBlock.el.innerHTML = window.nemoRenderMarkdown(textBlock.acc)
    scrollToEnd()
  }

  function appendThought(text) {
    if (thoughtBlock === null) {
      var wrap = document.createElement("details")
      wrap.className = "msg thought"
      var summary = document.createElement("summary")
      summary.textContent = "thinking"
      var body = document.createElement("div")
      wrap.appendChild(summary)
      wrap.appendChild(body)
      log.appendChild(wrap)
      thoughtBlock = { el: body, acc: "" }
    }
    thoughtBlock.acc += text
    thoughtBlock.el.innerHTML = window.nemoRenderMarkdown(thoughtBlock.acc)
    scrollToEnd()
  }

  function appendError(message) {
    closeStreams()
    var el = document.createElement("div")
    el.className = "msg error"
    el.textContent = message
    log.appendChild(el)
    scrollToEnd()
  }

  function onToolStart(id, name) {
    closeStreams()
    var el = document.createElement("div")
    el.className = "tool"
    el.dataset.state = "in_progress"
    var nameEl = document.createElement("span")
    nameEl.className = "tool-name"
    nameEl.textContent = name
    el.appendChild(nameEl)
    log.appendChild(el)
    tools[id] = { el: el, name: name }
    scrollToEnd()
  }

  function onToolEnd(id, isError, output) {
    var entry = tools[id]
    if (entry === undefined) return
    delete tools[id]
    entry.el.dataset.state = isError ? "failed" : "done"
    if (output && output.length > 0) {
      var details = document.createElement("details")
      if (isError) details.open = true
      var summary = document.createElement("summary")
      summary.textContent = "output"
      var pre = document.createElement("pre")
      // Verbatim contract: tool output is text, rendered as-is.
      pre.textContent = output
      details.appendChild(summary)
      details.appendChild(pre)
      entry.el.appendChild(details)
    }
    scrollToEnd()
  }

  function onDone(stopReason) {
    closeStreams()
    setBusy(false)
    if (stopReason === "end_turn") setStatus("ready", "ready")
    else if (stopReason === "cancelled") setStatus("cancelled", "cancelled")
    else setStatus("error", "error")
    input.focus()
  }

  function handleEvent(event) {
    if (!event || typeof event.type !== "string") return
    switch (event.type) {
      case "text":
        appendText(String(event.text || ""))
        return
      case "thinking":
        appendThought(String(event.text || ""))
        return
      case "tool_start":
        onToolStart(String(event.id), String(event.name || "tool"))
        return
      case "tool_end":
        onToolEnd(String(event.id), event.isError === true, String(event.output || ""))
        return
      case "error":
        appendError(String(event.message || "unknown error"))
        return
      case "done":
        onDone(String(event.stopReason || "end_turn"))
        return
      default:
        return
    }
  }

  function send() {
    if (busy) return
    var text = input.value.trim()
    if (text.length === 0) return
    appendUser(text)
    input.value = ""
    setBusy(true)
    setStatus("busy", "working…")
    api.prompt(text).then(function (result) {
      if (result && result.error) {
        appendError(result.error)
        setBusy(false)
        setStatus("error", "error")
      }
      // Terminal `done` events normally clear busy; the error branch above
      // covers prompt rejections that never produced one.
    })
  }

  sendBtn.addEventListener("click", send)
  stopBtn.addEventListener("click", function () {
    api.cancel()
  })
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })
  folderBtn.addEventListener("click", function () {
    api.chooseFolder().then(function (dir) {
      if (dir) workspaceEl.textContent = dir
    })
  })

  api.onEvent(handleEvent)

  // Boot: show the workspace the main process started with.
  if (typeof api.workspace === "function") {
    api.workspace().then(function (dir) {
      if (typeof dir === "string" && dir.length > 0) workspaceEl.textContent = dir
    })
  }
})()
