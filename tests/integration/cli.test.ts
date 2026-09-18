/**
 * @file End-to-end tests for `init` and `uninstall` (docs/development.md P1.3 functional checks).
 *
 * Runs the real CLI in a child process against temporary home directories, then executes the
 * installed `statusLine.command` exactly as Claude Code would: through a shell, with a payload on
 * stdin. This proves the pieces fit together, not just that each works alone.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SH, homeEnv } from "../setup/platform.js";

/** This repository's root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** A synthetic status line payload. */
const PAYLOAD = readFileSync(join(ROOT, "tests/fixtures/statusline/payload.json"));

/** Result of one CLI run. */
interface CliRun {
  /** stdout text. */
  readonly stdout: string;
  /** stderr text. */
  readonly stderr: string;
  /** Exit code. */
  readonly exitCode: number | null;
}

/**
 * Runs the CLI with a given HOME, through tsx as `npm run dev` does.
 * @param home - Value for HOME.
 * @param args - CLI arguments.
 * @returns Captured output and exit code.
 */
function cli(home: string, args: readonly string[]): CliRun {
  // tsx's own entry point under this Node: node_modules/.bin/tsx is a shell shim, which Windows can't spawn directly.
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "cli/main.cli.ts"), ...args],
    {
      encoding: "utf8",
      // Only the temporary home (HOME, and USERPROFILE on Windows) and what the platform needs:
      // no inherited CLAUDE_CONFIG_DIR or XDG variables, and never the real profile (D-049).
      env: homeEnv(home),
    },
  );
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

/**
 * Creates a temporary home, optionally with a settings file.
 * @param settingsText - Exact settings.json contents, or undefined for no file.
 * @returns The home directory and its settings path.
 */
function home(settingsText?: string): { home: string; settingsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "aua-e2e-"));
  const settingsPath = join(dir, ".claude", "settings.json");
  if (settingsText !== undefined) {
    mkdirSync(dirname(settingsPath));
    writeFileSync(settingsPath, settingsText);
  }
  return { home: dir, settingsPath };
}

/**
 * Runs the statusLine command from a settings file the way Claude Code does.
 * @param settingsPath - Settings file containing the installed command.
 * @returns The command's stdout and exit code.
 */
function runStatusLine(settingsPath: string): { stdout: string; exitCode: number | null } {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    statusLine: { command: string };
  };
  const result = spawnSync(SH, ["-c", settings.statusLine.command], { input: PAYLOAD });
  return { stdout: result.stdout.toString(), exitCode: result.status };
}

/**
 * Lists backup files next to a settings file.
 * @param settingsPath - The settings file.
 * @returns Backup file names.
 */
function backups(settingsPath: string): string[] {
  return readdirSync(dirname(settingsPath)).filter((name) => name.includes(".bak-"));
}

/** A custom status line with formatting JSON.stringify wouldn't produce. */
const CUSTOM =
  '{\n    "statusLine": {"type": "command", "command": "cat >/dev/null; printf \'custom %s\' ok", "padding": 0},\n    "theme": "dark"\n}\n';

describe("init on each settings state", () => {
  it("no settings file: creates one; the hook records and shows the model name", () => {
    const { home: h, settingsPath } = home();
    const run = cli(h, ["init"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Installed the status line hook");
    const status = runStatusLine(settingsPath);
    expect(status).toEqual({ stdout: "Sonnet 5\n", exitCode: 0 });
    const spool = join(h, ".local/share/nilometer/statusline.spool.jsonl");
    expect(readFileSync(spool, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("settings without statusLine: adds the hook and backs up first", () => {
    const { home: h, settingsPath } = home('{ "theme": "dark" }\n');
    expect(cli(h, ["init"]).exitCode).toBe(0);
    expect(backups(settingsPath)).toHaveLength(1);
    expect(runStatusLine(settingsPath).stdout).toBe("Sonnet 5\n");
  });

  it("custom statusLine: the status bar output is unchanged and the payload is recorded", () => {
    const { home: h, settingsPath } = home(CUSTOM);
    const before = spawnSync(SH, ["-c", "cat >/dev/null; printf 'custom %s' ok"], {
      input: PAYLOAD,
    }).stdout.toString();
    expect(cli(h, ["init"]).exitCode).toBe(0);
    expect(backups(settingsPath)).toHaveLength(1);
    expect(runStatusLine(settingsPath)).toEqual({ stdout: before, exitCode: 0 });
    const spool = join(h, ".local/share/nilometer/statusline.spool.jsonl");
    const line = JSON.parse(readFileSync(spool, "utf8")) as { payload_b64: string };
    expect(Buffer.from(line.payload_b64, "base64").equals(PAYLOAD)).toBe(true);
  });

  it("already wrapped: a second init changes nothing and makes no new backup", () => {
    const { home: h, settingsPath } = home(CUSTOM);
    cli(h, ["init"]);
    const afterFirst = readFileSync(settingsPath, "utf8");
    const second = cli(h, ["init"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already installed");
    expect(readFileSync(settingsPath, "utf8")).toBe(afterFirst);
    expect(backups(settingsPath)).toHaveLength(1);
  });

  it("invalid JSON: exits 1, explains, and leaves the file untouched with no backup", () => {
    const { home: h, settingsPath } = home("{ oops");
    const run = cli(h, ["init"]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("is not valid JSON");
    expect(readFileSync(settingsPath, "utf8")).toBe("{ oops");
    expect(backups(settingsPath)).toHaveLength(0);
  });
});

describe("ingest", () => {
  it("backfills during init and ingests hook readings afterwards, as JSON on stdout only", () => {
    const { home: h, settingsPath } = home();
    mkdirSync(join(h, ".claude", "projects"), { recursive: true });
    cpSync(join(ROOT, "fixtures/01-streaming-snapshots/projects"), join(h, ".claude", "projects"), {
      recursive: true,
    });
    const init = cli(h, ["init"]);
    expect(init.stdout).toContain("Stored: 2 requests");
    runStatusLine(settingsPath);
    const ingest = cli(h, ["ingest", "--json"]);
    expect(ingest.exitCode).toBe(0);
    expect(ingest.stderr).toBe("");
    const outcome = JSON.parse(ingest.stdout) as {
      run: { spoolRead: boolean; linesStored: number };
      totals: { requests: number; statusReadings: number };
    };
    expect(outcome.run).toMatchObject({ spoolRead: true, linesStored: 1 });
    expect(outcome.totals).toMatchObject({ requests: 2, statusReadings: 1 });
  });
});

describe("init, init, uninstall", () => {
  it("leaves settings.json byte-identical and keeps recorded data", () => {
    const { home: h, settingsPath } = home(CUSTOM);
    expect(cli(h, ["init"]).exitCode).toBe(0);
    runStatusLine(settingsPath);
    expect(cli(h, ["init"]).exitCode).toBe(0);
    const uninstall = cli(h, ["uninstall"]);
    expect(uninstall.exitCode).toBe(0);
    expect(readFileSync(settingsPath, "utf8")).toBe(CUSTOM);
    expect(existsSync(join(h, ".local/share/nilometer/statusline.spool.jsonl"))).toBe(true);
    // After uninstall the restored command runs as it always did.
    expect(runStatusLine(settingsPath).stdout).toBe("custom ok");
  });
});
