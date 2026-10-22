/**
 * @file Package contents check (audit check A23, plan-public R2.1, step G5.3).
 *
 * The npm package is what runs on a stranger's machine, so what goes in it is checked, not assumed:
 * 1. every file `npm pack` would publish matches the allowlist below, so nothing private, no tests,
 *    no fixtures, and no source maps ship;
 * 2. every file Nilometer reads at run time is in it: the compiled program for every source file,
 *    every migration, the price table, and the status line hook;
 * 3. no compiled file is left over from a source file that no longer exists, since `tsc` never deletes
 *    output and a stale module would ship;
 * 4. `package.json` can be published: not private, its command shipped, a license and a Node range set.
 *
 * The package's `files` field decides what npm includes; this check is the proof that it does.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { commandFound, invocation } from "../../core/util/commands.js";

/** What may be published. A packed file matching none of these is an error. */
export const ALLOWED: readonly RegExp[] = [
  /^dist\/(?:cli|core|viewer)\/.+\.js$/,
  /^core\/schema\/\d{3}_[a-z0-9_]+\.sql$/,
  /^core\/pricing\/prices\.json$/,
  /^hooks\/statusline\.sh$/,
  /^docs\/requirements\.md$/,
  // npm adds package.json, the README and the license by itself.
  /^(?:package\.json|README\.md|LICENSE|CHANGELOG\.md)$/,
];

/** Folders whose TypeScript compiles into `dist/` (tsconfig.build.json). */
export const SOURCE_DIRS: readonly string[] = ["cli", "core", "viewer"];

/** Files read at run time by path rather than imported, or named to the user, relative to the package root. */
export const RUNTIME_FILES: readonly string[] = [
  "package.json",
  "README.md",
  "core/pricing/prices.json",
  "hooks/statusline.sh",
  // Named by the Node.js version check's messages, so a user offline can still read it.
  "docs/requirements.md",
];

/** What the repository holds that the package has to reflect. */
export interface RepositoryFiles {
  /** Every `.ts` source under {@link SOURCE_DIRS}, relative and with `/` separators. */
  readonly sources: readonly string[];
  /** Every migration file name in `core/schema/`. */
  readonly migrations: readonly string[];
  /** Files that ship when they exist (the license and changelog come from the public overlay). */
  readonly optionalPresent: readonly string[];
}

/**
 * Lists the files the package must contain.
 * @param repo - What the repository holds.
 * @returns Package-relative paths, with `/` separators.
 */
export function requiredFiles(repo: RepositoryFiles): string[] {
  return [
    ...RUNTIME_FILES,
    ...repo.optionalPresent,
    ...repo.migrations.map((name) => `core/schema/${name}`),
    ...repo.sources.map((source) => `dist/${source.replace(/\.ts$/, ".js")}`),
  ];
}

/**
 * Compares what would be published with what must and may be.
 * @param packed - Paths `npm pack` lists.
 * @param repo - What the repository holds.
 * @returns One line per problem; empty when the package is right.
 */
export function checkPackage(packed: readonly string[], repo: RepositoryFiles): string[] {
  const required = requiredFiles(repo);
  const compiled = new Set(required.filter((path) => path.startsWith("dist/")));
  const have = new Set(packed);
  return [
    ...packed
      .filter((path) => !ALLOWED.some((pattern) => pattern.test(path)))
      .map((path) => `not on the allowlist: ${path}`),
    // Allowed by pattern but with no source: left over from a deleted or renamed file.
    ...packed
      .filter(
        (path) =>
          path.startsWith("dist/") &&
          !compiled.has(path) &&
          // Off-allowlist files are already named above.
          ALLOWED.some((pattern) => pattern.test(path)),
      )
      .map((path) => `compiled file with no source (rebuild from a clean dist/): ${path}`),
    ...required.filter((path) => !have.has(path)).map((path) => `missing: ${path}`),
  ];
}

/** The parts of `package.json` the check reads. */
export interface Manifest {
  /** npm refuses to publish a private package. */
  readonly private?: unknown;
  /** Command name to the file it runs. */
  readonly bin?: unknown;
  /** SPDX license. */
  readonly license?: unknown;
  /** Supported runtimes. */
  readonly engines?: { readonly node?: unknown };
}

/**
 * Checks that `package.json` can be published and installs a working command.
 * @param manifest - The parsed `package.json`.
 * @param packed - Paths `npm pack` lists.
 * @returns One line per problem; empty when it's right.
 */
export function checkManifest(manifest: Manifest, packed: readonly string[]): string[] {
  const problems: string[] = [];
  if (manifest.private === true) {
    problems.push('package.json is "private", so npm refuses to publish it');
  }
  const bin =
    typeof manifest.bin === "object" && manifest.bin !== null
      ? Object.values(manifest.bin as Record<string, unknown>)
      : [];
  if (bin.length === 0) {
    problems.push("package.json names no command under bin");
  }
  for (const target of bin) {
    if (typeof target !== "string" || !packed.includes(target.replace(/^\.\//, ""))) {
      problems.push(`the command's file isn't in the package: ${String(target)}`);
    }
  }
  if (typeof manifest.license !== "string" || manifest.license === "") {
    problems.push("package.json has no license");
  }
  if (typeof manifest.engines?.node !== "string") {
    problems.push("package.json has no engines.node range");
  }
  return problems;
}

/** Injectable effects for {@link main}. */
export interface PackageContentsDeps {
  /** Builds `dist/`; returns the exit code. */
  readonly build: () => number;
  /** Lists the files `npm pack` would publish, or returns an error message. */
  readonly pack: () => string[] | string;
  /** Reads what the repository holds. */
  readonly repository: () => RepositoryFiles;
  /** Reads `package.json`. */
  readonly manifest: () => Manifest;
  /** Writes one output line. */
  readonly print: (line: string) => void;
}

/**
 * Builds, packs without writing a tarball, and checks the file list.
 * @param deps - Effects.
 * @returns The exit code: 0 when the package is right.
 */
export function main(deps: PackageContentsDeps): number {
  const built = deps.build();
  if (built !== 0) {
    deps.print(`package contents: the build failed (exit ${built}), so there's nothing to check`);
    return 1;
  }
  const packed = deps.pack();
  if (typeof packed === "string") {
    deps.print(`package contents: npm pack failed: ${packed}`);
    return 1;
  }
  const problems = [
    ...checkPackage(packed, deps.repository()),
    ...checkManifest(deps.manifest(), packed),
  ];
  for (const problem of problems) {
    deps.print(`package contents: ${problem}`);
  }
  deps.print(
    problems.length === 0
      ? `package contents: PASS (${packed.length} files)`
      : `package contents: FAIL (${problems.length} problems in ${packed.length} files)`,
  );
  return problems.length === 0 ? 0 : 1;
}

/**
 * Lists `.ts` files below a folder, skipping declaration files.
 * @param root - Repository root.
 * @param dir - Folder relative to the root.
 * @returns Paths relative to the root, with `/` separators.
 */
export function listSources(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/**
 * Parses `npm pack --dry-run --json` output.
 * @param stdout - What npm printed on stdout.
 * @returns The packed paths, or an error message.
 */
export function parsePackJson(stdout: string): string[] | string {
  try {
    const parsed = JSON.parse(stdout) as { files?: { path: string }[] }[];
    const files = parsed[0]?.files;
    return Array.isArray(files)
      ? files.map((file) => file.path).sort()
      : "no file list in npm's output";
  } catch {
    return "npm's output wasn't JSON";
  }
}

/** Runs one command in a folder, returning its exit code and stdout. */
export type Runner = (
  root: string,
  command: string,
  args: readonly string[],
) => { status: number; stdout: string };

/**
 * Runs a command in a folder through the platform's spawn rules (D-051).
 * @param root - Working directory.
 * @param command - Executable name.
 * @param args - Arguments.
 * @returns Exit code and stdout; exit 127 when the command isn't installed.
 */
export const runIn: Runner = (root, command, args) => {
  if (!commandFound(command)) {
    return { status: 127, stdout: "" };
  }
  const call = invocation(command, args);
  const result = spawnSync(call.command, call.args, {
    cwd: root,
    shell: call.shell,
    encoding: "utf8",
    // The file list for a few hundred files is small, but npm's notices go to stderr regardless.
    stdio: ["ignore", "pipe", "inherit"],
  });
  return { status: result.status ?? 1, stdout: result.stdout };
};

/**
 * The real effects, rooted at the repository.
 * @param root - Repository root.
 * @param runner - Starts commands; injected so tests never run npm.
 * @returns Deps for {@link main}.
 */
export function defaultDeps(root: string, runner: Runner = runIn): PackageContentsDeps {
  return {
    build: () => runner(root, "npm", ["run", "build"]).status,
    pack: () => {
      // --ignore-scripts: packing must not run lifecycle scripts; .npmrc says the same (D-093).
      const result = runner(root, "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
      return result.status === 0 ? parsePackJson(result.stdout) : `exit ${result.status}`;
    },
    repository: () => ({
      sources: SOURCE_DIRS.flatMap((dir) => listSources(root, dir)),
      migrations: readdirSync(join(root, "core", "schema"))
        .filter((name) => name.endsWith(".sql"))
        .sort(),
      optionalPresent: ["LICENSE", "CHANGELOG.md"].filter((name) => existsSync(join(root, name))),
    }),
    manifest: () => JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest,
    print: (line) => {
      console.log(line);
    },
  };
}
