/**
 * @file Unit tests for core/util/open-page.ts, opening a saved page (D-082, step G2.10).
 *
 * The platform and the process start are injected, so no test launches a browser. The one test of
 * the real process start runs Node itself, which exits with a known code and opens nothing.
 */
import { describe, expect, it } from "vitest";

import type { Invocation } from "../../../../core/util/commands.js";
import {
  type OpenerRun,
  openPage,
  openerFor,
  spawnOpener,
} from "../../../../core/util/open-page.js";

/**
 * Records every invocation and answers each with the same result.
 * @param result - What the fake opener reports.
 * @returns The fake and the invocations it received.
 */
function fakeRun(result: OpenerRun): {
  run: (call: Invocation) => OpenerRun;
  calls: Invocation[];
} {
  const calls: Invocation[] = [];
  return {
    run: (call) => {
      calls.push(call);
      return result;
    },
    calls,
  };
}

describe("openerFor", () => {
  it("names open on macOS, start on Windows, and xdg-open elsewhere", () => {
    expect(openerFor("/r/p.html", "darwin")).toEqual({ command: "open", args: ["/r/p.html"] });
    // The empty first argument is start's window title, so the quoted path isn't taken as one.
    expect(openerFor("C:\\r\\p.html", "win32")).toEqual({
      command: "start",
      args: ["", "C:\\r\\p.html"],
    });
    expect(openerFor("/r/p.html", "linux")).toEqual({ command: "xdg-open", args: ["/r/p.html"] });
    expect(openerFor("/r/p.html", "freebsd")).toEqual({ command: "xdg-open", args: ["/r/p.html"] });
  });
});

describe("openPage", () => {
  it("passes the saved path to the opener as one argument, with no shell on macOS and Linux", () => {
    for (const [platform, command] of [
      ["darwin", "open"],
      ["linux", "xdg-open"],
    ] as const) {
      const fake = fakeRun({ status: 0 });
      const path = "/home/example/a b/report.html";
      expect(openPage(path, { platform, run: fake.run })).toEqual({ opened: true });
      expect(fake.calls).toEqual([{ command, args: [path], shell: false }]);
    }
  });

  it("builds one quoted cmd.exe line on Windows, as other commands are (D-051)", () => {
    const fake = fakeRun({ status: 0 });
    const path = "C:\\Users\\example\\data dir\\report.html";
    expect(openPage(path, { platform: "win32", run: fake.run })).toEqual({ opened: true });
    expect(fake.calls).toEqual([{ command: `start "" "${path}"`, args: [], shell: true }]);
  });

  it("says why when the opener exits with an error, is stopped, or can't start", () => {
    const cases: [OpenerRun, string][] = [
      [{ status: 3 }, "xdg-open exited with 3"],
      [{ status: null }, "xdg-open exited with no code"],
      [
        { status: null, error: new Error("spawnSync xdg-open ENOENT") },
        "xdg-open couldn't run: spawnSync xdg-open ENOENT",
      ],
    ];
    for (const [result, reason] of cases) {
      const fake = fakeRun(result);
      expect(openPage("/r/p.html", { platform: "linux", run: fake.run })).toEqual({
        opened: false,
        reason,
      });
    }
  });

  it("uses this machine's platform when none is given", () => {
    const fake = fakeRun({ status: 0 });
    openPage("/r/p.html", { run: fake.run });
    expect(fake.calls[0]?.command).toContain(openerFor("/r/p.html", process.platform).command);
  });
});

describe("spawnOpener", () => {
  it("waits for the process and reports its exit code, printing nothing", () => {
    const run = spawnOpener({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'); process.exit(3)"],
      shell: false,
    });
    expect(run.status).toBe(3);
    expect(run.error).toBeUndefined();
  });

  it("reports a command that doesn't exist as an error, not an exit code", () => {
    const run = spawnOpener({ command: "nilometer-no-such-opener", args: [], shell: false });
    expect(run.status).toBeNull();
    expect(run.error?.message).toMatch(/ENOENT/);
  });
});
