/**
 * @file Unit tests for scripts/audit/scan-personal.ts (audit check A10c).
 *
 * Lines containing realistic home paths carry the allow marker so this file passes the very scan
 * it tests. The strings under test are built from pieces, so the marker only exempts the
 * comment, never a real path.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALLOW_MARKER,
  type GitRunner,
  type ScanDeps,
  defaultDeps,
  isBinary,
  listRepoFiles,
  main,
  RULES,
  redactLine,
  scanText,
} from "../../../../scripts/audit/scan-personal.js";

/**
 * Builds a macOS home path from parts, so the literal never sits in this file unmarked.
 * @param name - Username segment.
 * @returns A path like `/Users/<name>/`.
 */
const macHome = (name: string): string => ["", "Users", name, ""].join("/");

/**
 * Builds a Linux home path from parts.
 * @param name - Username segment.
 * @returns A path like `/home/<name>/`.
 */
const linuxHome = (name: string): string => ["", "home", name, ""].join("/");

/**
 * Creates a GitRunner that returns fixed output.
 * @param stdout - Text to return as git's stdout.
 * @param exitCode - Exit code to return.
 * @returns A runner that records nothing and always returns the given result.
 */
function fakeGit(stdout: string, exitCode = 0): GitRunner {
  return () => ({ exitCode, stdout });
}

describe("scanText", () => {
  it("returns no findings for clean text", () => {
    expect(scanText("a.md", "nothing personal here\nstill nothing")).toEqual([]);
  });

  it("finds a macOS home path and redacts the username", () => {
    const findings = scanText("a.md", `path is ${macHome("jane")}projects`);
    expect(findings).toEqual([
      { path: "a.md", line: 1, rule: "home-path", excerpt: "path is /Users/<redacted>/projects" },
    ]);
  });

  it("finds Linux and Windows home paths", () => {
    const text = `${linuxHome("sam")}x\nC:\\Users\\kim\\docs`;
    const findings = scanText("b.txt", text);
    expect(findings.map((finding) => [finding.line, finding.excerpt])).toEqual([
      [1, "/home/<redacted>/x"],
      [2, "C:\\Users\\<redacted>\\docs"],
    ]);
  });

  it("reports every match on a line, with correct line numbers across CRLF endings", () => {
    const text = `first\r\n${macHome("a1")} and ${macHome("b2")}`;
    const findings = scanText("c.txt", text);
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.line === 2)).toBe(true);
    // Each finding's excerpt hides both names, not only the one it reports.
    expect(findings.every((finding) => !/a1|b2/.test(finding.excerpt))).toBe(true);
  });

  it("ignores documentation placeholders and the example name", () => {
    const text = `${macHome("<name>")}\n${linuxHome("example")}`;
    expect(scanText("d.md", text)).toEqual([]);
  });

  it("skips a line carrying the allow marker", () => {
    expect(scanText("e.ts", `${macHome("jane")} // ${ALLOW_MARKER}`)).toEqual([]);
  });

  it("truncates long excerpts to 160 characters", () => {
    const findings = scanText("f.txt", `${macHome("jane")}${"x".repeat(300)}`);
    expect(findings[0]?.excerpt).toHaveLength(160);
  });

  it("skips a match whose capture group is missing", () => {
    // A rule without a capture group can't identify the personal part, so it reports nothing.
    const rules = [{ id: "no-group", pattern: /secret/g }];
    expect(scanText("g.txt", "secret", rules)).toEqual([]);
  });
});

describe("redactLine", () => {
  it("replaces only the matched path segment, not the same letters elsewhere", () => {
    // Regression: redaction once replaced every "x" on the line, turning "Linux" into "Linu<redacted>".
    expect(redactLine(`Linux box ${linuxHome("x")}`, RULES)).toBe("Linux box /home/<redacted>/");
  });

  it("redacts every username on the line", () => {
    const line = `${macHome("ann")} then ${linuxHome("bob")}`;
    expect(redactLine(line, RULES)).toBe("/Users/<redacted>/ then /home/<redacted>/");
  });

  it("leaves placeholder names as written", () => {
    expect(redactLine(linuxHome("example"), RULES)).toBe("/home/example/");
  });

  it("leaves matches of a rule without a capture group unchanged", () => {
    expect(redactLine("a secret here", [{ id: "no-group", pattern: /secret/g }])).toBe(
      "a secret here",
    );
  });
});

describe("isBinary", () => {
  it("treats text bytes as not binary", () => {
    expect(isBinary(new TextEncoder().encode("plain text"))).toBe(false);
  });

  it("treats a NUL byte in the first 8000 bytes as binary", () => {
    expect(isBinary(Uint8Array.of(65, 0, 66))).toBe(true);
  });

  it("ignores a NUL byte after the first 8000 bytes, matching git", () => {
    const bytes = new Uint8Array(9000).fill(65);
    bytes[8500] = 0;
    expect(isBinary(bytes)).toBe(false);
  });
});

describe("listRepoFiles", () => {
  it("splits NUL-separated output and drops the trailing empty entry", () => {
    expect(listRepoFiles(fakeGit("a.md\0dir/b c.ts\0"))).toEqual(["a.md", "dir/b c.ts"]);
  });

  it("asks git for tracked and non-ignored untracked files", () => {
    const git = vi.fn<GitRunner>(() => ({ exitCode: 0, stdout: "" }));
    listRepoFiles(git);
    expect(git).toHaveBeenCalledWith(["ls-files", "-z", "-c", "-o", "--exclude-standard"]);
  });

  it("throws when git fails, rather than reporting a clean tree", () => {
    expect(() => listRepoFiles(fakeGit("", 128))).toThrow("git ls-files failed with exit code 128");
  });
});

describe("main", () => {
  /**
   * Builds scan dependencies over an in-memory file map.
   * @param files - Map of path to file contents; `null` simulates a deleted file.
   * @returns The dependencies plus the lines printed.
   */
  function depsFor(files: Record<string, string | Uint8Array | null>): {
    deps: ScanDeps;
    printed: string[];
  } {
    const printed: string[] = [];
    const deps: ScanDeps = {
      git: fakeGit(Object.keys(files).join("\0")),
      readFile: (path) => {
        const content = files[path];
        if (content === undefined || content === null) {
          return null;
        }
        return typeof content === "string" ? new TextEncoder().encode(content) : content;
      },
      print: (line) => printed.push(line),
    };
    return { deps, printed };
  }

  it("returns 0 and prints the count when the tree is clean", () => {
    const { deps, printed } = depsFor({ "a.md": "clean", "b.ts": "also clean" });
    expect(main(deps)).toBe(0);
    expect(printed).toEqual(["personal-data scan: 2 files scanned, 0 findings"]);
  });

  it("returns 1 and prints each finding with the username redacted", () => {
    const { deps, printed } = depsFor({ "a.md": `see ${macHome("jane")}notes` });
    expect(main(deps)).toBe(1);
    expect(printed).toEqual([
      "a.md:1 [home-path] see /Users/<redacted>/notes",
      "personal-data scan: 1 files scanned, 1 findings",
    ]);
  });

  it("skips binary files and files that no longer exist", () => {
    const { deps, printed } = depsFor({
      "img.png": Uint8Array.of(0, 1, 2),
      "gone.md": null,
      "ok.md": "fine",
    });
    expect(main(deps)).toBe(0);
    expect(printed.at(-1)).toBe("personal-data scan: 1 files scanned, 0 findings");
  });
});

describe("defaultDeps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs real git and returns its output", () => {
    const result = defaultDeps().git(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version/);
  });

  it("returns a non-zero exit code for a failing git command", () => {
    expect(defaultDeps().git(["no-such-subcommand"]).exitCode).not.toBe(0);
  });

  it("reads an existing file and returns null for a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-personal-"));
    const file = join(dir, "x.txt");
    writeFileSync(file, "hello");
    const { readFile } = defaultDeps();
    expect(new TextDecoder().decode(readFile(file) ?? new Uint8Array())).toBe("hello");
    expect(readFile(join(dir, "missing.txt"))).toBeNull();
  });

  it("prints through console.log", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    defaultDeps().print("line");
    expect(log).toHaveBeenCalledWith("line");
  });
});
