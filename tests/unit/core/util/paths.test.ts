/**
 * @file Unit tests for core/util/paths.ts.
 */
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { slash } from "../../../setup/platform.js";

import { expandHome } from "../../../../core/util/paths.js";

/** Fixed home directory so results never depend on the machine running the tests. */
const HOME = "/home/example";

describe("expandHome", () => {
  it("expands a bare tilde to the home directory", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
  });

  it("expands a leading tilde-slash to a path under the home directory", () => {
    expect(slash(expandHome("~/.claude/projects", HOME))).toBe("/home/example/.claude/projects");
  });

  it("normalizes a doubled separator after the tilde", () => {
    expect(slash(expandHome("~//logs", HOME))).toBe("/home/example/logs");
  });

  it("returns absolute paths unchanged", () => {
    expect(expandHome("/var/log/x.jsonl", HOME)).toBe("/var/log/x.jsonl");
  });

  it("returns relative paths unchanged", () => {
    expect(expandHome("fixtures/case-1", HOME)).toBe("fixtures/case-1");
  });

  it("leaves another user's ~user form unchanged", () => {
    expect(expandHome("~other/logs", HOME)).toBe("~other/logs");
  });

  it("leaves a tilde that is not at the start unchanged", () => {
    expect(expandHome("/data/~/logs", HOME)).toBe("/data/~/logs");
  });

  it("returns an empty path unchanged", () => {
    expect(expandHome("", HOME)).toBe("");
  });

  it("defaults to the current user's home directory", () => {
    expect(expandHome("~")).toBe(homedir());
  });
});
