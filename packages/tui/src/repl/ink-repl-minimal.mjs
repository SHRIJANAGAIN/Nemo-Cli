// Minimal Ink REPL for Nemo - ESM entry point
// This avoids the cross-package import issues by implementing a simple UI inline

import { render, Box, Text, useInput } from "ink"
import { createElement, useState, useEffect } from "react"
import { Agent } from "../../../../dist/apps/runtime/src/agent/agent.js"
import { loadConfig } from "../../../../dist/apps/runtime/src/config.js"

function loadConfigFromEnv() {
  const raw = process.env.NEMO_CONFIG_JSON
  if (raw) {
    try {
      return JSON.parse(raw)
    } catch {}
  }
  return loadConfig({})
}

const config = loadConfigFromEnv()

const NemoMinimalApp = () => {
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [agent, setAgent] = useState(null)
  const abortControllerRef = { current: null }

  useEffect(() => {
    const initAgent = async () => {
      const agentInstance = await Agent.create({
        config,
        sessionId: `ink-${Date.now()}`,
      })
      setAgent(agentInstance)
    }
    initAgent()
  }, [])

  useInput((input, key) => {
    if (key.return && input.trim() && !isLoading) {
      handleSubmit(input.trim())
    } else if (key.escape) {
      setInput("")
    } else if (key.backspace) {
      setInput(input.slice(0, -1))
    } else if (!key.return && !key.escape && !key.backspace && input) {
      setInput(input)
    }
  })

  const handleSubmit = async (userInput) => {
    setInput("")
    setIsLoading(true)
    setMessages((prev) => [...prev, { role: "user", content: userInput }])

    abortControllerRef.current = new AbortController()

    try {
      let fullResponse = ""
      await agent.run({
        prompt: userInput,
        signal: abortControllerRef.current.signal,
        onToken: (token) => {
          fullResponse += token
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, content: fullResponse }]
            }
            return [...prev, { role: "assistant", content: fullResponse }]
          })
        },
      })
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === "assistant") {
          return [...prev.slice(0, -1), { ...last, content: fullResponse, done: true }]
        }
        return [...prev, { role: "assistant", content: fullResponse, done: true }]
      })
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) => [...prev, { role: "system", content: `Error: ${err.message}` }])
      }
    } finally {
      setIsLoading(false)
    }
  }

  return createElement(
    Box,
    { flexDirection: "column", padding: 1 },
    createElement(Text, { color: "cyan", bold: true }, "NEMO Ink REPL"),
    createElement(Text, { color: "dim" }, "Type your message. Ctrl+C to exit."),
    createElement(Box, { marginTop: 1 }),
    createElement(
      Box,
      { flexDirection: "column", flexGrow: 1 },
      messages.map((msg, i) =>
        createElement(
          Box,
          { key: i, marginBottom: 1 },
          createElement(
            Text,
            { color: msg.role === "user" ? "green" : msg.role === "assistant" ? "white" : "yellow" },
            `${msg.role === "user" ? ">" : msg.role === "assistant" ? "◆" : "!"} ${msg.content}`,
          ),
        ),
      ),
      isLoading && createElement(Text, { color: "cyan" }, "◆ Thinking..."),
    ),
    createElement(Box, { marginTop: 1 }),
    createElement(Text, { color: "green", bold: true }, "> "),
    createElement(Text, { color: "white" }, input),
  )
}

const isTTY = process.stdin.isTTY
const renderOptions = {
  stdin: isTTY ? process.stdin : undefined,
  stdout: process.stdout,
}

render(createElement(NemoMinimalApp, { onExit: () => process.exit(0) }), renderOptions)
