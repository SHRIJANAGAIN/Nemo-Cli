export * as NemoNotebook from "./notebook"

export interface NotebookCell {
  readonly id: string
  readonly type: "code" | "markdown"
  readonly content: string
  readonly output?: string
  readonly executedAt?: Date
}

export interface Notebook {
  readonly id: string
  readonly name: string
  readonly cells: NotebookCell[]
  readonly createdAt: Date
  readonly updatedAt: Date
}

import { uniqueId } from "./unique-id.js"

export class NotebookService {
  private notebooks: Map<string, Notebook> = new Map()
  private activeNotebook?: Notebook

  create(name: string): Notebook {
    const notebook: Notebook = {
      // Disambiguated: two creates in one millisecond collided, and this Map
      // is keyed by id, so the second notebook replaced the first.
      id: uniqueId(`notebook-${Date.now()}`, this.notebooks.keys()),
      name,
      cells: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.notebooks.set(notebook.id, notebook)
    this.activeNotebook = notebook
    return notebook
  }

  getActive(): Notebook | undefined {
    return this.activeNotebook
  }

  get(id: string): Notebook | undefined {
    return this.notebooks.get(id)
  }

  addCell(notebookId: string, type: "code" | "markdown", content: string): NotebookCell | undefined {
    const notebook = this.notebooks.get(notebookId)
    if (!notebook) return undefined

    const cell: NotebookCell = {
      id: `cell-${Date.now()}`,
      type,
      content,
    }

    this.notebooks.set(notebookId, {
      ...notebook,
      cells: [...notebook.cells, cell],
      updatedAt: new Date(),
    })

    return cell
  }

  executeCell(notebookId: string, cellId: string, output: string): NotebookCell | undefined {
    const notebook = this.notebooks.get(notebookId)
    if (!notebook) return undefined

    const cells = notebook.cells.map((c) => (c.id === cellId ? { ...c, output, executedAt: new Date() } : c))

    this.notebooks.set(notebookId, {
      ...notebook,
      cells,
      updatedAt: new Date(),
    })

    return cells.find((c) => c.id === cellId)
  }

  list(): Notebook[] {
    return Array.from(this.notebooks.values())
  }
}

export const notebookService = new NotebookService()
