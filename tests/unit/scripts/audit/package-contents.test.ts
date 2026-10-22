/**
 * @file Unit tests for scripts/audit/package-contents.ts (audit check A23, step G5.3).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  type PackageContentsDeps,
  type RepositoryFiles,
  type Runner,
  checkManifest,
  checkPackage,
  defaultDeps,
  listSources,
  main,
  parsePackJson,
  requiredFiles,
  runIn,
} from "../../../../scripts/audit/package-contents.js";

/** A small repository: two sources, two migrations, and a license. */
const REPO: RepositoryFiles = {
  sources: ["cli/main.cli.ts", "core/db/database.ts"],
  migrations: ["001_ingestion.sql", "002_line_count.sql"],
  optionalPresent: ["LICENSE"],
};

/** Exactly what {@link REPO}'s package should hold. */
const GOOD = [
  "LICENSE",
  "README.md",
  "core/pricing/prices.json",
  "core/schema/001_ingestion.sql",
  "core/schema/002_line_count.sql",
  "dist/cli/main.cli.js",
  "dist/core/db/database.js",
  "docs/requirements.md",
  "hooks/statusline.sh",
  "package.json",
];

describe("requiredFiles", () => {
  it("names the runtime files, the present optional ones, every migration and every compiled source", () => {
    expect(requiredFiles(REPO).sort()).toEqual(GOOD);
  });
});

describe("checkPackage", () => {
  it("passes a package holding exactly what is required", () => {
    expect(checkPackage(GOOD, REPO)).toEqual([]);
  });

  it("names a file off the allowlist: private notes, tests, fixtures, source maps", () => {
    const extra = [
      "private-notes.md",
      "tests/unit/x.test.ts",
      "fixtures/01/a.jsonl",
      "dist/cli/main.cli.js.map",
    ];
    expect(checkPackage([...GOOD, ...extra], REPO)).toEqual(
      extra.map((path) => `not on the allowlist: ${path}`),
    );
  });

  it("names a compiled file whose source is gone, though its path is allowed", () => {
    expect(checkPackage([...GOOD, "dist/core/old.js"], REPO)).toEqual([
      "compiled file with no source (rebuild from a clean dist/): dist/core/old.js",
    ]);
  });

  it("names every required file that is missing", () => {
    const without = GOOD.filter(
      (path) =>
        !["hooks/statusline.sh", "core/schema/002_line_count.sql", "LICENSE"].includes(path),
    );
    expect(checkPackage(without, REPO)).toEqual([
      "missing: hooks/statusline.sh",
      "missing: LICENSE",
      "missing: core/schema/002_line_count.sql",
    ]);
  });
});

/** A publishable manifest whose command is in {@link GOOD}. */
const MANIFEST = {
  bin: { nilometer: "dist/cli/main.cli.js" },
  license: "MIT",
  engines: { node: ">=24" },
};

describe("checkManifest", () => {
  it("passes a publishable manifest whose command ships", () => {
    expect(checkManifest(MANIFEST, GOOD)).toEqual([]);
    expect(
      checkManifest({ ...MANIFEST, bin: { nilometer: "./dist/cli/main.cli.js" } }, GOOD),
    ).toEqual([]);
  });

  it("names a private package, a missing or unshipped command, no license, and no Node range", () => {
    expect(
      checkManifest({ private: true, bin: { nilometer: "dist/gone.js", other: 1 } }, GOOD),
    ).toEqual([
      'package.json is "private", so npm refuses to publish it',
      "the command's file isn't in the package: dist/gone.js",
      "the command's file isn't in the package: 1",
      "package.json has no license",
      "package.json has no engines.node range",
    ]);
    expect(checkManifest({ ...MANIFEST, bin: undefined }, GOOD)).toEqual([
      "package.json names no command under bin",
    ]);
  });
});

/**
 * Deps that pack the given list and record what was printed.
 * @param pack - What packing returns.
 * @param build - The build's exit code.
 * @returns The deps and the printed lines.
 */
function fake(pack: string[] | string, build = 0): { deps: PackageContentsDeps; out: string[] } {
  const out: string[] = [];
  return {
    deps: {
      build: () => build,
      pack: () => pack,
      repository: () => REPO,
      manifest: () => MANIFEST,
      print: (l) => out.push(l),
    },
    out,
  };
}

describe("main", () => {
  it("passes and says how many files it checked", () => {
    const { deps, out } = fake(GOOD);
    expect(main(deps)).toBe(0);
    expect(out).toEqual(["package contents: PASS (10 files)"]);
  });

  it("fails with one line per problem", () => {
    const { deps, out } = fake([...GOOD, "private-notes.md"]);
    expect(main(deps)).toBe(1);
    expect(out).toEqual([
      "package contents: not on the allowlist: private-notes.md",
      "package contents: FAIL (1 problems in 11 files)",
    ]);
  });

  it("stops before packing when the build fails", () => {
    const pack = vi.fn(() => GOOD);
    const { deps, out } = fake(GOOD, 2);
    expect(main({ ...deps, pack })).toBe(1);
    expect(pack).not.toHaveBeenCalled();
    expect(out).toEqual([
      "package contents: the build failed (exit 2), so there's nothing to check",
    ]);
  });

  it("fails when npm pack does", () => {
    const { deps, out } = fake("exit 1");
    expect(main(deps)).toBe(1);
    expect(out).toEqual(["package contents: npm pack failed: exit 1"]);
  });
});

describe("parsePackJson", () => {
  it("reads the file paths, sorted", () => {
    expect(parsePackJson(JSON.stringify([{ files: [{ path: "b" }, { path: "a" }] }]))).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns a message for output that isn't JSON, or has no file list", () => {
    expect(parsePackJson("npm notice")).toBe("npm's output wasn't JSON");
    expect(parsePackJson("[]")).toBe("no file list in npm's output");
  });
});

describe("listSources", () => {
  it("lists .ts files below a folder with / separators, skipping declaration files", () => {
    const root = mkdtempSync(join(tmpdir(), "nilometer-pack-"));
    mkdirSync(join(root, "core", "db"), { recursive: true });
    for (const file of ["core/a.ts", "core/db/b.ts", "core/types.d.ts", "core/notes.md"]) {
      writeFileSync(join(root, file), "");
    }
    expect(listSources(root, "core")).toEqual(["core/a.ts", "core/db/b.ts"]);
  });
});

describe("defaultDeps", () => {
  it("builds and packs through npm in the repository root, ignoring lifecycle scripts", () => {
    const calls: string[] = [];
    /**
     * Records each command and answers pack with one file, build with exit 3.
     * @param root - Working directory.
     * @param command - Executable.
     * @param args - Arguments.
     * @returns A fake result.
     */
    const runner: Runner = (root, command, args) => {
      calls.push([root, command, ...args].join(" "));
      return args[0] === "pack"
        ? { status: 0, stdout: JSON.stringify([{ files: [{ path: "package.json" }] }]) }
        : { status: 3, stdout: "" };
    };
    const deps = defaultDeps("/repo", runner);
    expect(deps.build()).toBe(3);
    expect(deps.pack()).toEqual(["package.json"]);
    expect(calls).toEqual([
      "/repo npm run build",
      "/repo npm pack --dry-run --json --ignore-scripts",
    ]);
  });

  it("reports npm pack's exit code when it fails", () => {
    const deps = defaultDeps("/repo", () => ({ status: 1, stdout: "" }));
    expect(deps.pack()).toBe("exit 1");
  });

  it("reads this repository: its sources, migrations, and whichever optional files exist", () => {
    const root = join(import.meta.dirname, "../../../..");
    const repo = defaultDeps(root).repository();
    expect(repo.sources).toContain("cli/main.cli.ts");
    expect(repo.sources.every((s) => /^(cli|core|viewer)\/.+\.ts$/.test(s))).toBe(true);
    expect(repo.migrations[0]).toBe("001_ingestion.sql");
    expect(repo.optionalPresent.every((f) => ["LICENSE", "CHANGELOG.md"].includes(f))).toBe(true);
    expect(checkManifest(defaultDeps(root).manifest(), ["dist/cli/main.cli.js"])).toEqual([]);
  });

  it("prints to the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    defaultDeps("/repo").print("line");
    expect(log).toHaveBeenCalledWith("line");
    log.mockRestore();
  });
});

describe("runIn", () => {
  it("runs a command in a folder and returns its exit code and stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "nilometer-run-"));
    const result = runIn(dir, "node", [
      "-e",
      "process.stdout.write(process.cwd()); process.exit(4)",
    ]);
    expect(result.status).toBe(4);
    expect(result.stdout).toContain("nilometer-run-");
  });
});
