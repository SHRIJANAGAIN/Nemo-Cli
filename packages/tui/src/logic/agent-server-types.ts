/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Stub types for OpenHands agent-server event interfaces.
 * These provide minimal type compatibility for components that reference
 * the OpenHands event system.
 */

export interface Action {
  kind: string
  path?: string
  command?: string
  [key: string]: unknown
}

export interface Observation {
  kind: string
  path?: string
  command?: string
  [key: string]: unknown
}

export interface OpenHandsEvent {
  eventId: string
  timestamp: string
  action: Action
  observation: Observation
  [key: string]: unknown
}

export interface ActionEvent<T extends Action = Action> {
  type: "action"
  eventId: string
  timestamp: string
  action: T
}

export interface ObservationEvent<T extends Observation = Observation> {
  type: "observation"
  eventId: string
  timestamp: string
  observation: T
}

export type FileEditorAction = Action & {
  kind: "FileEditorAction" | "StrReplaceEditorAction"
  path: string
  command: string
}

export type StrReplaceEditorAction = Action & {
  kind: "StrReplaceEditorAction"
  path?: string
  command?: string
  oldStr?: string
  newStr?: string
}

export type FileEditorObservation = Observation & {
  kind: "FileEditorObservation"
  path?: string
  command?: string
}

export type StrReplaceEditorObservation = Observation & {
  kind: "StrReplaceEditorObservation"
  path?: string
  command?: string
}

export function isActionEvent(event: unknown): event is ActionEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "action" in event &&
    typeof (event as Record<string, unknown>).action === "object"
  )
}

export function isObservationEvent(event: unknown): event is ObservationEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "observation" in event &&
    typeof (event as Record<string, unknown>).observation === "object"
  )
}
