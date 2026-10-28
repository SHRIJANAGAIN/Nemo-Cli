/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { BoardService } from "./board.js"

/**
 * The board is a mini message log: broadcasts reach everyone, directed
 * messages only their recipient, "ALL" reads everything, and participants
 * accumulate in post order (seeded with "local").
 */
describe("BoardService.post", () => {
  it("stamps id/timestamp and records the author as a participant", () => {
    const service = new BoardService()
    const message = service.post({ author: "alice", content: "hi" })
    expect(message.id).toMatch(/^board-\d+$/)
    expect(message.timestamp).toBeInstanceOf(Date)
    expect(message.content).toBe("hi")
    expect(message.recipient).toBeUndefined()
    expect(service.getParticipants()).toEqual(["local", "alice"])
  })

  it("gives two posts in the same millisecond distinct ids", () => {
    const service = new BoardService()
    // No clock step between these: Date.now() is identical, so the ids used to
    // collide (two messages sharing one id).
    const first = service.post({ author: "alice", content: "one" })
    const second = service.post({ author: "alice", content: "two" })

    expect(second.id).not.toBe(first.id)
    expect(new Set(service.read("ALL").map((m) => m.id)).size).toBe(2)
  })

  it("adds the recipient as a participant too", () => {
    const service = new BoardService()
    service.post({ author: "alice", content: "for bob", recipient: "bob" })
    expect(service.getParticipants()).toEqual(["local", "alice", "bob"])
  })

  it("keeps participants unique across posts", () => {
    const service = new BoardService()
    service.post({ author: "alice", content: "one" })
    service.post({ author: "alice", content: "two" })
    expect(service.getParticipants()).toEqual(["local", "alice"])
  })
})

describe("BoardService.read", () => {
  const board = (): BoardService => {
    const service = new BoardService()
    service.post({ author: "alice", content: "to all" })
    service.post({ author: "bob", content: "to alice", recipient: "alice" })
    service.post({ author: "carol", content: "to bob", recipient: "bob" })
    return service
  }

  it("a plain read returns broadcasts only", () => {
    expect(
      board()
        .read()
        .map((message) => message.content),
    ).toEqual(["to all"])
  })

  it("reading for a participant returns broadcasts plus their direct messages", () => {
    expect(
      board()
        .read("alice")
        .map((message) => message.content),
    ).toEqual(["to all", "to alice"])
    expect(
      board()
        .read("bob")
        .map((message) => message.content),
    ).toEqual(["to all", "to bob"])
  })

  it("reading for a listener with no directs still sees broadcasts", () => {
    expect(
      board()
        .read("dave")
        .map((message) => message.content),
    ).toEqual(["to all"])
  })

  it('reading "ALL" returns every message, directs included', () => {
    expect(
      board()
        .read("ALL")
        .map((message) => message.content),
    ).toEqual(["to all", "to alice", "to bob"])
  })

  it("an empty board reads as an empty list", () => {
    expect(new BoardService().read()).toEqual([])
    expect(new BoardService().read("ALL")).toEqual([])
  })
})

describe("BoardService.clear", () => {
  it("drops messages but keeps the participant roster", () => {
    const service = new BoardService()
    service.post({ author: "alice", content: "hi" })
    service.clear()
    expect(service.read("ALL")).toEqual([])
    expect(service.getParticipants()).toEqual(["local", "alice"])
  })
})
