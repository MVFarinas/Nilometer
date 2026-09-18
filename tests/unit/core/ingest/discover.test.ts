/**
 * @file Unit tests for core/ingest/discover.ts (docs/development.md P4.1).
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAN_SYMLINK, slash } from "../../../setup/platform.js";

import {
  DiscoveryError,
  compareBytes,
  discoverLogFiles,
  isDirectory,
  resolveRoots,
  unique,
} from "../../../../core/ingest/discover.js";

/**
 * Builds a directory test that says yes only for the given paths.
 * @param existing - Paths that exist as directories.
 * @returns A directory test function.
 */
function dirs(...existing: string[]): (path: string) => boolean {
  const set = new Set(existing);
  // resolveRoots joins with the platform separator; the expectations are written with "/".
  return (path) => set.has(slash(path));
}

/**
 * Creates files (and their directories) under a fresh root.
 * @param files - Paths relative to the root.
 * @returns The root.
 */
function tree(...files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "aua-discover-"));
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{}\n");
  }
  return root;
}

describe("resolveRoots", () => {
  const home = "/home/example";

  it("defaults to ~/.claude when it has projects/", () => {
    expect(resolveRoots({}, home, dirs("/home/example/.claude/projects")).map(slash)).toEqual([
      "/home/example/.claude",
    ]);
  });

  it("puts an absolute XDG_CONFIG_HOME/claude before ~/.claude", () => {
    const isDir = dirs("/xdg/claude/projects", "/home/example/.claude/projects");
    expect(resolveRoots({ XDG_CONFIG_HOME: "/xdg" }, home, isDir).map(slash)).toEqual([
      "/xdg/claude",
      "/home/example/.claude",
    ]);
  });

  it("ignores a relative XDG_CONFIG_HOME", () => {
    const isDir = dirs("rel/claude/projects", "/home/example/.claude/projects");
    expect(resolveRoots({ XDG_CONFIG_HOME: "rel" }, home, isDir).map(slash)).toEqual([
      "/home/example/.claude",
    ]);
  });

  it("returns no roots when no default has projects/", () => {
    expect(resolveRoots({}, home, dirs())).toEqual([]);
  });

  it("uses only CLAUDE_CONFIG_DIR when set, splitting commas, trimming, expanding ~, dropping repeats", () => {
    const isDir = dirs("/a/projects", "/home/example/b/projects", "/home/example/.claude/projects");
    expect(
      resolveRoots({ CLAUDE_CONFIG_DIR: " /a , ~/b,,/a , /missing" }, home, isDir).map(slash),
    ).toEqual(["/a", "/home/example/b"]);
  });

  it("treats a blank CLAUDE_CONFIG_DIR as unset", () => {
    expect(
      resolveRoots({ CLAUDE_CONFIG_DIR: "  " }, home, dirs("/home/example/.claude/projects")).map(
        slash,
      ),
    ).toEqual(["/home/example/.claude"]);
  });

  it("throws when CLAUDE_CONFIG_DIR names nothing usable", () => {
    expect(() => resolveRoots({ CLAUDE_CONFIG_DIR: "/nope" }, home, dirs())).toThrow(
      DiscoveryError,
    );
    expect(() => resolveRoots({ CLAUDE_CONFIG_DIR: "/nope" }, home, dirs())).toThrow(
      "none of its entries contains a projects/ directory: /nope",
    );
    expect(new DiscoveryError("x").name).toBe("DiscoveryError");
  });

  it("uses the real filesystem by default", () => {
    const root = tree("projects/p/s.jsonl");
    expect(resolveRoots({ CLAUDE_CONFIG_DIR: root }, home)).toEqual([root]);
  });
});

describe("isDirectory", () => {
  it("is true for a directory and false for a file or a missing path", () => {
    const root = tree("f.txt");
    expect(isDirectory(root)).toBe(true);
    expect(isDirectory(join(root, "f.txt"))).toBe(false);
    expect(isDirectory(join(root, "missing"))).toBe(false);
  });
});

describe("unique", () => {
  it("keeps the first occurrence of each value, in order", () => {
    expect(unique(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });
});

describe("compareBytes", () => {
  it("orders by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF61 is one UTF-16 unit (0xFF61) but UTF-8 EF BD A1; U+1F600 is a surrogate pair
    // (0xD83D...) but UTF-8 F0 9F 98 80. By code unit the emoji sorts first; by bytes it sorts last.
    const halfwidth = "｡";
    const emoji = "\u{1f600}";
    expect([emoji, halfwidth].sort()).toEqual([emoji, halfwidth]);
    expect([emoji, halfwidth].sort(compareBytes)).toEqual([halfwidth, emoji]);
  });

  it("puts '.' before '/' so a session file sorts before its subagent directory", () => {
    expect(["projects/p/s1/subagents/a.jsonl", "projects/p/s1.jsonl"].sort(compareBytes)).toEqual([
      "projects/p/s1.jsonl",
      "projects/p/s1/subagents/a.jsonl",
    ]);
  });
});

describe("discoverLogFiles", () => {
  it("finds .jsonl files at any depth, sorted, relative to the root", () => {
    const root = tree(
      "projects/p/s2.jsonl",
      "projects/p/s1.jsonl",
      "projects/p/s1/subagents/deep/deeper/a.jsonl",
      "projects/q/notes.txt",
      "other/ignored.jsonl",
    );
    expect(discoverLogFiles(root)).toEqual([
      "projects/p/s1.jsonl",
      "projects/p/s1/subagents/deep/deeper/a.jsonl",
      "projects/p/s2.jsonl",
    ]);
  });

  it.skipIf(!CAN_SYMLINK)("skips symlinks to files and directories", () => {
    const root = tree("projects/p/real.jsonl");
    symlinkSync(join(root, "projects/p/real.jsonl"), join(root, "projects/p/link.jsonl"));
    symlinkSync(join(root, "projects/p"), join(root, "projects/loop"));
    expect(discoverLogFiles(root)).toEqual(["projects/p/real.jsonl"]);
  });

  it("returns nothing for an empty projects directory", () => {
    const root = mkdtempSync(join(tmpdir(), "aua-discover-empty-"));
    mkdirSync(join(root, "projects"));
    expect(discoverLogFiles(root)).toEqual([]);
  });

  it("finds every committed fixture file for case 11, including the subagent transcript", () => {
    const fixture = join(import.meta.dirname, "../../../../fixtures/11-subagent-file");
    expect(discoverLogFiles(fixture)).toEqual([
      "projects/-fixture-demo/s11.jsonl",
      "projects/-fixture-demo/s11/subagents/agent-a1.jsonl",
    ]);
  });
});
