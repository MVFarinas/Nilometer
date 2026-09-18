/**
 * @file Unit tests for core/install/locations.ts.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { slash } from "../../../setup/platform.js";

import {
  DATA_DIR_NAME,
  HOOK_RELATIVE_PATH,
  findPackageRoot,
  resolveDataDir,
} from "../../../../core/install/locations.js";

/** Fixed home directory so results never depend on the machine running the tests. */
const HOME = "/home/example";

describe("resolveDataDir", () => {
  it("defaults to ~/.local/share/nilometer", () => {
    expect(slash(resolveDataDir({ home: HOME, env: {} }))).toBe(
      "/home/example/.local/share/nilometer",
    );
  });

  it("uses an absolute XDG_DATA_HOME", () => {
    expect(slash(resolveDataDir({ home: HOME, env: { XDG_DATA_HOME: "/data/xdg" } }))).toBe(
      `/data/xdg/${DATA_DIR_NAME}`,
    );
  });

  it("ignores a relative XDG_DATA_HOME, as the XDG spec requires", () => {
    expect(slash(resolveDataDir({ home: HOME, env: { XDG_DATA_HOME: "relative/dir" } }))).toBe(
      "/home/example/.local/share/nilometer",
    );
  });

  it("prefers NILOMETER_HOME over XDG_DATA_HOME, expanding a tilde", () => {
    expect(
      slash(
        resolveDataDir({
          home: HOME,
          env: { NILOMETER_HOME: "~/aua", XDG_DATA_HOME: "/data/xdg" },
        }),
      ),
    ).toBe("/home/example/aua");
  });

  it("makes a relative --data-dir or NILOMETER_HOME absolute (D-050)", () => {
    // init writes this path into the status line command, and the hook would otherwise resolve it
    // against whatever project Claude Code runs in.
    const fromFlag = resolveDataDir({ home: HOME, env: {}, override: "mydata" });
    const fromEnv = resolveDataDir({ home: HOME, env: { NILOMETER_HOME: "../mydata" } });
    for (const path of [fromFlag, fromEnv]) {
      expect(isAbsolute(path)).toBe(true);
    }
    expect(fromFlag).toBe(resolve(process.cwd(), "mydata"));
    expect(fromEnv).toBe(resolve(process.cwd(), "../mydata"));
    // An absolute value is untouched, and "~" still expands.
    expect(slash(resolveDataDir({ home: HOME, env: {}, override: "~/aua" }))).toBe(
      "/home/example/aua",
    );
  });

  it("prefers the --data-dir flag over everything", () => {
    expect(
      resolveDataDir({
        home: HOME,
        env: { NILOMETER_HOME: "/env/aua" },
        override: "/flag/aua",
      }),
    ).toBe("/flag/aua");
  });

  it("treats empty strings as unset", () => {
    expect(
      slash(
        resolveDataDir({
          home: HOME,
          env: { NILOMETER_HOME: "", XDG_DATA_HOME: "" },
          override: "",
        }),
      ),
    ).toBe("/home/example/.local/share/nilometer");
  });
});

describe("findPackageRoot", () => {
  it("finds this repository's root from a nested directory", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = findPackageRoot(here);
    expect(root).toBe(join(here, "../../../.."));
  });

  it("walks up until both marker files exist", () => {
    // HOOK_RELATIVE_PATH uses the platform separator; the fake filesystem is written with "/".
    const present = new Set([
      "/a/package.json",
      `/a/${slash(HOOK_RELATIVE_PATH)}`,
      "/a/b/package.json",
    ]);
    expect(slash(findPackageRoot("/a/b/c", (path) => present.has(slash(path))))).toBe("/a");
  });

  it("throws when no ancestor has the hook script", () => {
    expect(() => findPackageRoot("/x/y", () => false)).toThrow(
      `could not find ${HOOK_RELATIVE_PATH} above /x/y`,
    );
  });
});
