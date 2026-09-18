/**
 * @file Unit tests for scripts/util/commands.ts, starting programs on every platform (D-051).
 *
 * The Windows behaviour is the point of this module and can't be exercised on macOS or Linux, so
 * the platform and the lookups are injected and the Windows cases are asserted by their results:
 * the exact command line, and whether a command counts as found.
 */
import { describe, expect, it } from "vitest";

import {
  NOT_STARTED,
  WINDOWS_NOT_RECOGNIZED,
  commandFound,
  invocation,
  quoteForCmd,
  windowsCommandLine,
} from "../../../../scripts/util/commands.js";

describe("quoteForCmd", () => {
  it("quotes only what cmd.exe would otherwise split or interpret", () => {
    expect(quoteForCmd("tsc")).toBe("tsc");
    expect(quoteForCmd("--noEmit")).toBe("--noEmit");
    expect(quoteForCmd(".")).toBe(".");
    expect(quoteForCmd("hooks/statusline.sh")).toBe("hooks/statusline.sh");
    // The case that broke A4: a real command path with a space in it.
    expect(quoteForCmd("C:\\Program Files\\nodejs\\node.exe")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"',
    );
    expect(quoteForCmd("process.exit(3)")).toBe('"process.exit(3)"');
    expect(quoteForCmd("a&b")).toBe('"a&b"');
    expect(quoteForCmd("%PATH%")).toBe('"%PATH%"');
    // An empty argument has to survive as an argument.
    expect(quoteForCmd("")).toBe('""');
  });

  it("refuses a word containing a double quote rather than guessing", () => {
    // How an embedded quote must be escaped depends on how the receiving program parses its
    // arguments, so this reports instead of building a command line that means something else.
    expect(() => quoteForCmd('say "hi"')).toThrow(/contains a double quote/);
  });
});

describe("windowsCommandLine", () => {
  it("joins the command and its arguments into one quoted line", () => {
    expect(windowsCommandLine("vitest", ["run", "--coverage"])).toBe("vitest run --coverage");
    expect(
      windowsCommandLine("C:\\Program Files\\nodejs\\node.exe", ["-e", "process.exit(3)"]),
    ).toBe('"C:\\Program Files\\nodejs\\node.exe" -e "process.exit(3)"');
  });
});

describe("invocation", () => {
  it("passes the command and arguments straight through off Windows", () => {
    expect(invocation("gitleaks", ["dir", "."], "darwin")).toEqual({
      command: "gitleaks",
      args: ["dir", "."],
      shell: false,
    });
    expect(invocation("tsc", ["--noEmit"], "linux").shell).toBe(false);
  });

  it("gives Windows one pre-quoted line and no arguments", () => {
    // Node concatenates arguments without escaping them when a shell runs the command (DEP0190),
    // so the whole line is quoted here instead.
    expect(invocation("prettier", ["--check", "."], "win32")).toEqual({
      command: "prettier --check .",
      args: [],
      shell: true,
    });
    expect(invocation("C:\\Program Files\\nodejs\\node.exe", ["-v"], "win32").command).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" -v',
    );
  });
});

describe("commandFound", () => {
  it("leaves the answer to the spawn off Windows, where a missing command reports itself", () => {
    expect(commandFound("definitely-not-a-real-tool", { platform: "darwin" })).toBe(true);
  });

  it("looks a bare name up with where.exe on Windows", () => {
    // cmd.exe reports a command it can't find as exit 1, which a check's own failure also uses.
    /**
     * Stands in for `where.exe`: everything resolves except gitleaks.
     * @param name - The command being looked up.
     * @returns 0 when it resolves, 1 when it doesn't.
     */
    const found = (name: string): number => (name === "gitleaks" ? 1 : 0);
    expect(commandFound("tsc", { platform: "win32", probe: found })).toBe(true);
    expect(commandFound("gitleaks", { platform: "win32", probe: found })).toBe(false);
    // `where` reports failure as a null status when it can't run at all.
    expect(commandFound("tsc", { platform: "win32", probe: () => null })).toBe(false);
  });

  it("checks a path on disk instead, since where.exe takes patterns", () => {
    /**
     * Stands in for the filesystem: only Node's own path is there.
     * @param path - The path being checked.
     * @returns Whether it exists.
     */
    const exists = (path: string): boolean => path === "C:\\Program Files\\nodejs\\node.exe";
    expect(commandFound("C:\\Program Files\\nodejs\\node.exe", { platform: "win32", exists })).toBe(
      true,
    );
    expect(commandFound("C:\\nope\\gone.exe", { platform: "win32", exists })).toBe(false);
    expect(commandFound("node_modules/.bin/tsc", { platform: "win32", exists })).toBe(false);
  });
});

describe("commandFound with the real lookups", () => {
  it("uses where.exe and the filesystem when nothing is injected", () => {
    // Covers the defaults. This test runs on macOS and Linux too, where there is no `where.exe`:
    // the probe can't start, so a bare name is reported as not found. A path still resolves on
    // disk, which is the branch that doesn't depend on Windows at all.
    expect(commandFound("node", { platform: "win32" })).toBe(process.platform === "win32");
    expect(commandFound(process.execPath, { platform: "win32" })).toBe(true);
  });
});

describe("exit codes", () => {
  it("names the two codes the audit runner treats as 'did not run'", () => {
    expect(NOT_STARTED).toBe(127);
    // The Windows Store's python3 stub exits with this instead of running Python.
    expect(WINDOWS_NOT_RECOGNIZED).toBe(9009);
  });
});
