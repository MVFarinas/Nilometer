/**
 * @file Unit tests for scripts/install/rehearse.ts (step G5.4). npm and the installed command are faked,
 * acting on a real temporary home, so the rehearsal's checks are tested without a network or a tarball.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type Run,
  STARTING_SETTINGS,
  globalBin,
  installedCommand,
  isolatedEnv,
  lineCount,
  rehearse,
  spawnRun,
  statusLineCommand,
} from "../../../../scripts/install/rehearse.js";

/** Changes to the fake's behavior, one per failure a test wants. */
interface Faults {
  /** `init` exits with this code. */
  readonly initStatus?: number;
  /** Uninstalling the package also deletes the hook, as an install that named the package would. */
  readonly hookInPackage?: boolean;
  /** `uninstall` leaves this in the settings file instead of the original. */
  readonly uninstallLeaves?: string;
}

/**
 * A fake npm, nilometer and sh that act on the home directory the way the real ones do.
 * @param home - The rehearsal's home.
 * @param faults - Failures to simulate.
 * @returns The runner, and the commands it was given.
 */
function fakeWorld(home: string, faults: Faults = {}): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const command = installedCommand(join(home, ".npm-global"), "linux");
  const settings = join(home, ".claude", "settings.json");
  const dataDir = join(home, ".local", "share", "nilometer");
  let hookPresent = false;
  /**
   * Answers one command.
   * @param cmd - Executable.
   * @param args - Arguments.
   * @returns What it would return.
   */
  const run: Run = (cmd, args) => {
    calls.push([cmd === command ? "nilometer" : cmd, ...args].join(" "));
    if (cmd === "npm") {
      if (args[0] === "install") {
        mkdirSync(dirname(command), { recursive: true });
        writeFileSync(command, "");
      } else {
        rmSync(command);
        hookPresent = hookPresent && faults.hookInPackage !== true;
      }
      return { status: 0, stdout: "" };
    }
    if (cmd === "sh") {
      if (!hookPresent) {
        return { status: 127, stdout: "" };
      }
      mkdirSync(dataDir, { recursive: true });
      appendFileSync(join(dataDir, "statusline.spool.jsonl"), "{}\n");
      return { status: 0, stdout: "Sonnet 5\n" };
    }
    switch (args[0]) {
      case "--help":
        return { status: 0, stdout: "Usage: nilometer [options] [command]\n" };
      case "--version":
        return { status: 0, stdout: "0.1.0\n" };
      case "init":
        hookPresent = true;
        writeFileSync(
          settings,
          JSON.stringify({ statusLine: { command: "sh x # nilometer-hook" } }),
        );
        return { status: faults.initStatus ?? 0, stdout: "" };
      case "report":
        return { status: 0, stdout: "Claude subscription usage\n" };
      case "uninstall":
        writeFileSync(settings, faults.uninstallLeaves ?? STARTING_SETTINGS);
        return { status: 0, stdout: "" };
      default:
        return { status: 0, stdout: "" };
    }
  };
  return { run, calls };
}

/**
 * Runs the rehearsal in a new home with a fake world.
 * @param faults - Failures to simulate.
 * @returns Its result, the commands run, and what it printed.
 */
function rehearseWith(faults: Faults = {}) {
  const home = mkdtempSync(join(tmpdir(), "nilometer-rehearse-"));
  const projects = mkdtempSync(join(tmpdir(), "nilometer-projects-"));
  writeFileSync(join(projects, "s.jsonl"), "{}\n");
  const { run, calls } = fakeWorld(home, faults);
  const out: string[] = [];
  const result = rehearse({
    tarball: "/pkg/nilometer-0.1.0.tgz",
    home,
    projects,
    payload: Buffer.from("{}"),
    platform: "linux",
    baseEnv: { PATH: "/usr/bin" },
    run,
    print: (line) => out.push(line),
  });
  return { ...result, calls, out };
}

describe("rehearse", () => {
  it("passes every step when install, recording, removal and uninstall all behave", () => {
    const { ok, steps, calls, out } = rehearseWith();
    expect(ok).toBe(true);
    expect(steps).toHaveLength(16);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(calls).toEqual([
      "npm install -g /pkg/nilometer-0.1.0.tgz",
      "nilometer --help",
      "nilometer --version",
      "nilometer init",
      "sh -c sh x # nilometer-hook",
      "npm uninstall -g nilometer",
      "sh -c sh x # nilometer-hook",
      "npm install -g /pkg/nilometer-0.1.0.tgz",
      "nilometer ingest",
      "nilometer report",
      "nilometer uninstall",
    ]);
    expect(out.at(-1)).toBe("install rehearsal: PASS");
  });

  it("stops at the first step that fails", () => {
    const { ok, steps, out } = rehearseWith({ initStatus: 1 });
    expect(ok).toBe(false);
    expect(steps.map((s) => [s.name, s.ok])).toEqual([
      ["npm install -g <tarball>", true],
      ["nilometer --help", true],
      ["nilometer --version", true],
      ["nilometer init", false],
    ]);
    expect(out).toContain("FAIL nilometer init");
    expect(out.at(-1)).toBe("install rehearsal: FAIL");
  });

  it("fails when recording stops with the package gone (D-056)", () => {
    const { ok, steps } = rehearseWith({ hookInPackage: true });
    expect(ok).toBe(false);
    expect(steps.at(-1)).toEqual({ name: "the status line still shows text", ok: false });
  });

  it("fails when uninstall doesn't restore the settings file exactly", () => {
    const { ok, steps } = rehearseWith({ uninstallLeaves: '{"theme":"dark"}' });
    expect(ok).toBe(false);
    expect(steps.at(-1)?.name).toBe("settings.json is byte-identical to how it started");
  });
});

describe("where npm puts the command", () => {
  it("uses prefix/bin off Windows, and the prefix itself with a .cmd shim on Windows", () => {
    expect(globalBin("/h/.npm-global", "linux")).toBe(join("/h/.npm-global", "bin"));
    expect(globalBin("/h/.npm-global", "win32")).toBe("/h/.npm-global");
    expect(installedCommand("/h/g", "darwin")).toBe(join("/h/g", "bin", "nilometer"));
    expect(installedCommand("/h/g", "win32")).toBe(join("/h/g", "nilometer.cmd"));
  });
});

describe("isolatedEnv", () => {
  it("keeps only PATH, behind the install's own commands, and gives npm its own prefix and cache", () => {
    const env = isolatedEnv("/h", "linux", { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/real" });
    expect(env).toEqual({
      HOME: "/h",
      PATH: [join("/h", ".npm-global", "bin"), "/usr/bin"].join(delimiter),
      npm_config_prefix: join("/h", ".npm-global"),
      npm_config_cache: join("/h", ".npm-cache"),
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
    });
  });

  it("on Windows also moves the profile folders and keeps the system variables programs need", () => {
    const env = isolatedEnv("/h", "win32", {
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      PATHEXT: ".COM;.EXE;.CMD",
      APPDATA: "C:\\real",
    });
    expect(env["USERPROFILE"]).toBe("/h");
    expect(env["APPDATA"]).toBe(join("/h", "AppData", "Roaming"));
    expect(env["LOCALAPPDATA"]).toBe(join("/h", "AppData", "Local"));
    expect(env["SystemRoot"]).toBe("C:\\Windows");
    expect(env["PATHEXT"]).toBe(".COM;.EXE;.CMD");
    expect(env["TEMP"]).toBeUndefined();
    expect(env["PATH"]).toBe([join("/h", ".npm-global"), "C:\\Windows"].join(delimiter));
  });

  it("starts from an empty PATH when there is none", () => {
    expect(isolatedEnv("/h", "linux", {})["PATH"]).toBe(
      [join("/h", ".npm-global", "bin"), ""].join(delimiter),
    );
  });
});

describe("statusLineCommand", () => {
  it("reads the command, or undefined when there's none, it isn't text, or the file isn't JSON", () => {
    expect(statusLineCommand('{"statusLine":{"command":"sh x"}}')).toBe("sh x");
    expect(statusLineCommand('{"theme":"dark"}')).toBeUndefined();
    expect(statusLineCommand('{"statusLine":{"command":1}}')).toBeUndefined();
    expect(statusLineCommand("{")).toBeUndefined();
  });
});

describe("lineCount", () => {
  it("counts non-empty lines, and 0 for a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nilometer-lines-"));
    expect(lineCount(join(dir, "none"))).toBe(0);
    writeFileSync(join(dir, "f"), "a\nb\n");
    expect(lineCount(join(dir, "f"))).toBe(2);
  });
});

describe("spawnRun", () => {
  it("passes stdin and the environment, and returns the exit code and stdout", () => {
    const result = spawnRun(
      "node",
      ["-e", "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exit(3))"],
      { PATH: process.env["PATH"] ?? "" },
      Buffer.from("payload"),
    );
    expect(result).toEqual({ status: 3, stdout: "payload" });
  });
});
