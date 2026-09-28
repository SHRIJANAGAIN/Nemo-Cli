/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * AGENTS.md Discovery — project-level instruction assembly.
 *
 * Mirrors codex-rs/core/src/agents_md.rs in Rust.
 * Discovers AGENTS.md files along the path from project root
 * to current working directory, concatenating their contents.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

/** Default filename scanned for AGENTS.md instructions. */
export const DEFAULT_AGENTS_MD_FILENAME = "AGENTS.md";

/** Default project root markers (when not explicitly configured). */
export const DEFAULT_PROJECT_ROOT_MARKERS: string[] = [".git"];

/**
 * Project root marker configuration.
 */
export interface ProjectRootMarkers {
    markers: string[];
    fallbackFilenames: string[];
    maxBytes: number;
}

/** Default project root marker config. */
export const DEFAULT_PROJECT_ROOT_MARKER_CONFIG: ProjectRootMarkers = {
    markers: DEFAULT_PROJECT_ROOT_MARKERS,
    fallbackFilenames: [DEFAULT_AGENTS_MD_FILENAME],
    maxBytes: 4096,
};

/** Found AGENTS.md file with its content and path. */
export interface AgentsMdFile {
    path: string;
    content: string;
    isProjectRoot: boolean;
}

/**
 * Find the project root by walking upwards from cwd.
 * Returns the first directory containing a marker file.
 */
export function findProjectRoot(cwd: string, markers: string[] = DEFAULT_PROJECT_ROOT_MARKERS): string {
    let current = cwd;

    while (true) {
        for (const marker of markers) {
            if (existsSync(join(current, marker))) {
                return current;
            }
        }

        const parent = dirname(current);
        if (parent === current) {
            // Reached filesystem root without finding a marker
            return cwd;
        }
        current = parent;
    }
}

/**
 * Discover all AGENTS.md files from project root down to cwd.
 *
 * Mirrors the Rust logic:
 * 1. Determine the project root by walking upwards from cwd
 *    until a configured marker is found.
 * 2. Collect every AGENTS.md found from project root down to cwd.
 * 3. Do NOT walk past the project root.
 */
export function discoverAgentsMdFiles(
    cwd: string,
    config?: Partial<ProjectRootMarkers>,
): AgentsMdFile[] {
    const cfg = { ...DEFAULT_PROJECT_ROOT_MARKER_CONFIG, ...config };
    const projectRoot = findProjectRoot(cwd, cfg.markers);
    const files: AgentsMdFile[] = [];

    // Walk from cwd up to project root, collecting AGENTS.md files
    let current = cwd;
    const visited = new Set<string>();

    while (true) {
        if (visited.has(current)) break;
        visited.add(current);

        // Check for AGENTS.md or fallback filenames
        for (const filename of cfg.fallbackFilenames) {
            const filePath = join(current, filename);
            if (existsSync(filePath)) {
                const content = readFileSync(filePath, "utf8");
                files.push({
                    path: filePath,
                    content: content.slice(0, cfg.maxBytes),
                    isProjectRoot: current === projectRoot,
                });
            }
        }

        const parent = dirname(current);
        if (parent === current || current === projectRoot) break;
        current = parent;
    }

    // Reverse so files are ordered from project root to cwd
    return files.reverse();
}

/**
 * Load and concatenate all AGENTS.md files into a single instruction string.
 *
 * Mirrors the Rust `load_agents_md` function.
 */
export function loadProjectInstructions(
    cwd: string,
    config?: Partial<ProjectRootMarkers>,
): string | null {
    const files = discoverAgentsMdFiles(cwd, config);

    if (files.length === 0) {
        return null;
    }

    // Concatenate all files in order (project root → cwd)
    const allContent = files.map(f => f.content).join("\n\n");
    return allContent;
}

/**
 * Get project instructions with a limit on total bytes.
 */
export function getProjectInstructionsWithLimit(
    cwd: string,
    maxBytes: number = 4096,
    config?: Partial<ProjectRootMarkers>,
): string {
    const files = discoverAgentsMdFiles(cwd, { ...config, maxBytes });
    return files.map(f => f.content).join("\n\n").slice(0, maxBytes);
}

/**
 * Check if a directory contains any AGENTS.md or fallback files.
 */
export function hasProjectInstructions(cwd: string, config?: Partial<ProjectRootMarkers>): boolean {
    return loadProjectInstructions(cwd, config) !== null;
}
