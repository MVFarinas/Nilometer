/**
 * @file Tests for core/ingest/attribution.ts (docs/development.md P4.6), using real git repositories.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { slash } from "../../../setup/platform.js";

import { applyMigrations, listMigrations, openDatabase } from "../../../../core/db/database.js";
import {
  type GitRunner,
  type RepoResolution,
  gitRoot,
  isStale,
  resolveRepo,
  resolveRepositories,
  runGit,
} from "../../../../core/ingest/attribution.js";
import { ensureDerived } from "../../../../core/ingest/derive.js";
import { ingestLogs } from "../../../../core/ingest/ingest.js";

/** Repository paths. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Writes a resolution's root with "/" separators, as git returns it on every platform (D-049).
 * @param resolution - A resolution.
 * @returns The same resolution, its root (if any) with "/" separators.
 */
function slashed(resolution: RepoResolution): RepoResolution {
  return "repoRoot" in resolution && resolution.repoRoot !== null
    ? { ...resolution, repoRoot: slash(resolution.repoRoot) }
    : resolution;
}

/**
 * A fixed clock for resolution timestamps.
 * @returns 2026-09-13T00:00:00Z.
 */
function now(): Date {
  return new Date("2026-09-13T00:00:00Z");
}

/**
 * Runs git in a directory, failing the test if it fails.
 * @param cwd - Working directory.
 * @param args - Git arguments.
 * @throws {Error} With git's stderr when git exits non-zero.
 */
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

/**
 * Creates a repository with one commit, a subdirectory, and a linked worktree.
 * @returns Canonical paths of the repo, its subdirectory, and the worktree.
 */
function repoWithWorktree(): { repo: string; sub: string; worktree: string } {
  // realpath: macOS temp dirs live under a /var → /private/var symlink, and git reports real paths.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aua-attr-")));
  const repo = join(base, "demo");
  mkdirSync(join(repo, "packages", "sub"), { recursive: true });
  git(base, "init", "-q", "demo");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "worktree", "add", "-q", join(base, "demo-worktree"));
  return { repo, sub: join(repo, "packages", "sub"), worktree: join(base, "demo-worktree") };
}

describe("runGit", () => {
  it("returns trimmed stdout and the exit code", () => {
    expect(runGit(["--version"])).toMatchObject({ exitCode: 0 });
    expect(runGit(["--version"]).stdout).toMatch(/^git version \S+/);
    expect(runGit(["no-such-command"]).exitCode).not.toBe(0);
  });
});

describe("resolveRepo", () => {
  it("resolves a main clone, a subdirectory, and a worktree to the same repository", () => {
    const { repo, sub, worktree } = repoWithWorktree();
    const expected = slashed({ kind: "repo", repoRoot: repo });
    expect(slashed(resolveRepo(repo))).toEqual(expected);
    expect(slashed(resolveRepo(sub))).toEqual(expected);
    expect(slashed(resolveRepo(worktree))).toEqual(expected);
  });

  it("uses a bare repository's own directory as its root", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "aua-bare-")));
    git(base, "init", "-q", "--bare", "store.git");
    expect(slashed(resolveRepo(join(base, "store.git")))).toEqual(
      slashed({ kind: "repo", repoRoot: join(base, "store.git") }),
    );
  });

  it("labels a directory outside any repository as not_git", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "aua-nogit-")));
    expect(resolveRepo(outside)).toEqual({ kind: "not_git" });
  });

  it("gives a missing directory its last-known root without running git (D-028)", () => {
    let calls = 0;
    /**
     * Counts calls and never succeeds.
     * @returns A failing result.
     */
    const counting: GitRunner = () => {
      calls += 1;
      return { exitCode: 1, stdout: "" };
    };
    expect(resolveRepo("/definitely/gone", "/definitely", counting)).toEqual({
      kind: "missing",
      repoRoot: "/definitely",
      via: "last_known",
    });
    expect(calls).toBe(0);
  });

  it("attributes a deleted subdirectory to the repository of its nearest existing parent", () => {
    const { repo } = repoWithWorktree();
    // Two levels below an existing folder of the repository, neither of which exists.
    expect(slashed(resolveRepo(join(repo, "packages", "gone", "deeper")))).toEqual(
      slashed({ kind: "missing", repoRoot: repo, via: "parent" }),
    );
  });

  it("leaves a missing directory outside any repository without a root, asking git only about the parent", () => {
    const seen: string[] = [];
    /**
     * Records the directory git is asked about, and finds no repository.
     * @param args - Git arguments; the directory follows -C.
     * @returns A failing result.
     */
    const recording: GitRunner = (args) => {
      seen.push(args[1] as string);
      return { exitCode: 128, stdout: "" };
    };
    const existing = new Set(["/", "/home"]);
    expect(
      resolveRepo("/home/example/gone/deeper", null, recording, (p) => existing.has(p)),
    ).toEqual({
      kind: "missing",
      repoRoot: null,
      via: "none",
    });
    expect(seen).toEqual(["/home"]);
    // A path whose every parent is missing, even the root, gets no root and no git call.
    expect(resolveRepo("/a/b", null, recording, () => false)).toEqual({
      kind: "missing",
      repoRoot: null,
      via: "none",
    });
    expect(seen).toEqual(["/home"]);
  });

  it("treats empty git output as not_git", () => {
    expect(
      resolveRepo(
        "/x",
        null,
        () => ({ exitCode: 0, stdout: "" }),
        () => true,
      ),
    ).toEqual({ kind: "not_git" });
    expect(gitRoot("/x", () => ({ exitCode: 0, stdout: "/x/.git" }))).toBe("/x");
  });
});

describe("resolveRepositories", () => {
  it("resolves fixture 14's three working directories to one repository, one git call per cwd", () => {
    const { repo } = repoWithWorktree();
    const groups = JSON.parse(
      readFileSync(join(ROOT, "fixtures/14-worktree-cwd/repo-groups.json"), "utf8"),
    ) as string[][];
    // Stage the fixture with {{REPO}} replaced by the real repository path.
    const logRoot = mkdtempSync(join(tmpdir(), "aua-attr-logs-"));
    const source = join(ROOT, "fixtures/14-worktree-cwd/projects/-fixture-demo");
    mkdirSync(join(logRoot, "projects/-fixture-demo"), { recursive: true });
    for (const name of ["s14a.jsonl", "s14b.jsonl", "s14c.jsonl"]) {
      writeFileSync(
        join(logRoot, "projects/-fixture-demo", name),
        // JSON-escaped: a Windows path's backslashes would otherwise break the JSON lines.
        readFileSync(join(source, name), "utf8").replaceAll(
          "{{REPO}}",
          JSON.stringify(repo).slice(1, -1),
        ),
      );
    }
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    ingestLogs(db, { roots: [logRoot], mode: "incremental", now });
    ensureDerived(db);

    const seen: string[] = [];
    expect(resolveRepositories(db, now, (cwd) => (seen.push(cwd), resolveRepo(cwd)))).toBe(3);
    expect(seen).toEqual([...groups[0]!].map((cwd) => cwd.replace("{{REPO}}", repo)).sort());
    const rows = db.prepare("SELECT DISTINCT repository FROM request_repositories").all();
    expect(rows).toEqual([{ repository: slash(repo) }]);
    // Already-resolved directories are never resolved again.
    expect(
      resolveRepositories(db, now, () => {
        throw new Error("should not resolve again");
      }),
    ).toBe(0);
  });

  it("writes a Windows repository one way: uppercase drive letter and / separators (D-049)", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    const logRoot = mkdtempSync(join(tmpdir(), "aua-attr-windows-"));
    mkdirSync(join(logRoot, "projects/p"), { recursive: true });
    // Observed on Windows (2026-09-17): one deleted folder logged with both drive letter cases, and
    // a repository root from git with "/" separators. Hand-computed: two repositories, not three.
    const lines = [
      ["c:\\gone\\app", "a"],
      ["C:\\gone\\app", "b"],
      ["C:\\work\\repo\\sub", "c"],
    ].map(([cwd, id]) =>
      JSON.stringify({
        type: "assistant",
        sessionId: "s",
        cwd,
        message: { id, model: "m", usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    );
    writeFileSync(join(logRoot, "projects/p/s.jsonl"), `${lines.join("\n")}\n`);
    ingestLogs(db, { roots: [logRoot], mode: "incremental", now });
    ensureDerived(db);
    resolveRepositories(
      db,
      now,
      (cwd) =>
        cwd.endsWith("sub")
          ? { kind: "repo", repoRoot: "C:/work/repo" }
          : { kind: "missing", repoRoot: null, via: "none" },
      () => true,
    );
    expect(
      db
        .prepare(
          "SELECT repository, COUNT(*) AS requests FROM request_repositories GROUP BY 1 ORDER BY 1",
        )
        .all(),
    ).toEqual([
      { repository: "C:/gone/app", requests: 2 },
      { repository: "C:/work/repo", requests: 1 },
    ]);
    // The stored working directories keep their source spelling.
    expect(
      db
        .prepare("SELECT cwd FROM repositories ORDER BY cwd")
        .all()
        .map((row) => (row as { cwd: string }).cwd),
    ).toEqual(["C:\\gone\\app", "C:\\work\\repo\\sub", "c:\\gone\\app"]);
  });

  it("records missing and non-git directories, falling back to the cwd as the repository", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    const logRoot = mkdtempSync(join(tmpdir(), "aua-attr-labels-"));
    mkdirSync(join(logRoot, "projects/p"), { recursive: true });
    /**
     * Builds a request line with a working directory.
     * @param cwd - Working directory to record.
     * @param id - Message ID.
     * @returns The JSON line.
     */
    const line = (cwd: string, id: string): string =>
      JSON.stringify({
        type: "assistant",
        sessionId: "s",
        cwd,
        message: {
          id,
          model: "m",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
        },
      });
    writeFileSync(
      join(logRoot, "projects/p/s.jsonl"),
      `${line("/gone/away", "a")}\n${line("/tmp", "b")}\n`,
    );
    ingestLogs(db, { roots: [logRoot], mode: "incremental", now });
    ensureDerived(db);
    resolveRepositories(
      db,
      now,
      (cwd) =>
        cwd === "/gone/away"
          ? { kind: "missing", repoRoot: null, via: "none" }
          : { kind: "not_git" },
      (path) => path === "/tmp",
    );
    expect(
      db
        .prepare(
          "SELECT cwd, kind, repo_root, root_exists, resolved_via, resolved_at FROM repositories ORDER BY cwd",
        )
        .all(),
    ).toEqual([
      {
        cwd: "/gone/away",
        kind: "missing",
        repo_root: null,
        root_exists: null,
        resolved_via: "none",
        resolved_at: "2026-09-13T00:00:00.000Z",
      },
      {
        cwd: "/tmp",
        kind: "not_git",
        repo_root: null,
        root_exists: null,
        resolved_via: "git",
        resolved_at: "2026-09-13T00:00:00.000Z",
      },
    ]);
    expect(
      db.prepare("SELECT cwd, repo_kind, repository FROM request_repositories ORDER BY cwd").all(),
    ).toEqual([
      { cwd: "/gone/away", repo_kind: "missing", repository: "/gone/away" },
      { cwd: "/tmp", repo_kind: "not_git", repository: "/tmp" },
    ]);
  });

  it("re-resolves a directory that disappears, keeps its last-known root, and follows the root's existence", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    const logRoot = mkdtempSync(join(tmpdir(), "aua-attr-stale-"));
    mkdirSync(join(logRoot, "projects/p"), { recursive: true });
    writeFileSync(
      join(logRoot, "projects/p/s.jsonl"),
      `${JSON.stringify({ type: "assistant", sessionId: "s", cwd: "/r/sub", message: { id: "a", model: "m", usage: {} } })}\n`,
    );
    ingestLogs(db, { roots: [logRoot], mode: "incremental", now });
    ensureDerived(db);
    const onDisk = new Set(["/r", "/r/sub"]);
    /**
     * Resolves with the real rules over a fake filesystem where /r is a repository.
     * @param cwd - Working directory.
     * @param last - Last-known root.
     * @returns The resolution.
     */
    const resolve = (cwd: string, last: string | null): RepoResolution =>
      resolveRepo(
        cwd,
        last,
        () => ({ exitCode: 0, stdout: "/r/.git" }),
        (p) => onDisk.has(p),
      );
    /**
     * Reads the cached row and the request's attribution.
     * @returns Both, for comparison.
     */
    const state = (): unknown => [
      db.prepare("SELECT kind, repo_root, root_exists, resolved_via FROM repositories").get(),
      db.prepare("SELECT repo_kind, repository, resolved_via FROM request_repositories").get(),
    ];
    /**
     * Existence over the fake filesystem.
     * @param p - Path.
     * @returns Whether it's in the set.
     */
    const exists = (p: string): boolean => onDisk.has(p);

    expect(resolveRepositories(db, now, resolve, exists)).toBe(1);
    expect(state()).toEqual([
      { kind: "repo", repo_root: "/r", root_exists: 1, resolved_via: "git" },
      { repo_kind: "repo", repository: "/r", resolved_via: "git" },
    ]);
    // Nothing changed on disk: nothing is resolved again.
    expect(
      resolveRepositories(
        db,
        now,
        () => {
          throw new Error("not stale");
        },
        exists,
      ),
    ).toBe(0);

    // The subdirectory is deleted; the repository remains, so the request still counts as /r.
    onDisk.delete("/r/sub");
    expect(resolveRepositories(db, now, resolve, exists)).toBe(1);
    expect(state()).toEqual([
      { kind: "missing", repo_root: "/r", root_exists: 1, resolved_via: "last_known" },
      { repo_kind: "repo", repository: "/r", resolved_via: "last_known" },
    ]);

    // The repository is renamed away too: same root, labeled missing.
    onDisk.delete("/r");
    expect(resolveRepositories(db, now, resolve, exists)).toBe(1);
    expect(state()).toEqual([
      { kind: "missing", repo_root: "/r", root_exists: 0, resolved_via: "last_known" },
      { repo_kind: "missing", repository: "/r", resolved_via: "last_known" },
    ]);

    // Both come back: git runs in the directory again.
    onDisk.add("/r").add("/r/sub");
    expect(resolveRepositories(db, now, resolve, exists)).toBe(1);
    expect(state()).toEqual([
      { kind: "repo", repo_root: "/r", root_exists: 1, resolved_via: "git" },
      { repo_kind: "repo", repository: "/r", resolved_via: "git" },
    ]);
  });

  it("doesn't treat a root found from a parent folder as last known", () => {
    const row = {
      cwd: "/r/gone",
      kind: "missing",
      repo_root: "/r",
      root_exists: 1,
      resolved_via: "parent",
    } as const;
    expect(isStale(row, (p) => p === "/r")).toBe(false);
    expect(isStale(row, () => false)).toBe(true);
    expect(
      isStale(
        { ...row, kind: "not_git", repo_root: null, root_exists: null, resolved_via: "git" },
        () => true,
      ),
    ).toBe(false);
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    db.prepare(
      "INSERT INTO repositories (cwd, kind, repo_root, root_exists, resolved_via, resolved_at) VALUES ('/r/gone', 'missing', '/r', 1, 'parent', 'x')",
    ).run();
    const lastKnown: (string | null)[] = [];
    resolveRepositories(
      db,
      now,
      (_cwd, last) => {
        lastKnown.push(last);
        return { kind: "missing", repoRoot: null, via: "none" };
      },
      () => false,
    );
    // The parent lookup is redone rather than trusted as a git answer for the directory itself.
    expect(lastKnown).toEqual([null]);
  });

  it("migration 013 carries repo and not_git rows and drops missing ones for re-resolution", () => {
    const db = new Database(":memory:");
    const all = listMigrations(join(ROOT, "core/schema"));
    applyMigrations(
      db,
      all.filter((m) => m.version <= 12),
      now,
    );
    const insert = db.prepare(
      "INSERT INTO repositories (cwd, kind, repo_root, resolved_at) VALUES (?, ?, ?, 'x')",
    );
    insert.run("/a", "repo", "/a");
    insert.run("/b", "not_git", null);
    insert.run("/c", "missing", null);
    expect(applyMigrations(db, all, now)).toEqual(
      all.filter((m) => m.version > 12).map((m) => m.version),
    );
    expect(
      db
        .prepare(
          "SELECT cwd, kind, repo_root, root_exists, resolved_via FROM repositories ORDER BY cwd",
        )
        .all(),
    ).toEqual([
      { cwd: "/a", kind: "repo", repo_root: "/a", root_exists: 1, resolved_via: "git" },
      { cwd: "/b", kind: "not_git", repo_root: null, root_exists: null, resolved_via: "git" },
    ]);
    // The recreated views work.
    expect(db.prepare("SELECT COUNT(*) AS n FROM obs_usage_by_repo").get()).toEqual({ n: 0 });
    expect(() =>
      db
        .prepare(
          "INSERT INTO repositories (cwd, kind, repo_root, root_exists, resolved_via, resolved_at) VALUES ('/d', 'repo', NULL, NULL, 'git', 'x')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("uses real git resolution by default", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    const logRoot = mkdtempSync(join(tmpdir(), "aua-attr-default-"));
    mkdirSync(join(logRoot, "projects/p"), { recursive: true });
    writeFileSync(
      join(logRoot, "projects/p/s.jsonl"),
      `${JSON.stringify({ type: "user", cwd: "/definitely/not/here" })}\n`,
    );
    ingestLogs(db, { roots: [logRoot], mode: "incremental", now });
    ensureDerived(db);
    expect(resolveRepositories(db, now)).toBe(1);
    expect(db.prepare("SELECT kind, resolved_via FROM repositories").get()).toEqual({
      kind: "missing",
      resolved_via: "none",
    });
    // A real repository whose subdirectory is renamed away keeps its root on the next run.
    const { repo, sub } = repoWithWorktree();
    writeFileSync(
      join(logRoot, "projects/p/t.jsonl"),
      `${JSON.stringify({ type: "user", cwd: sub })}\n`,
    );
    ingestLogs(db, { roots: [logRoot], mode: "incremental", now });
    ensureDerived(db);
    expect(resolveRepositories(db, now)).toBe(1);
    renameSync(sub, `${sub}-renamed`);
    expect(resolveRepositories(db, now)).toBe(1);
    const renamed = db
      .prepare("SELECT kind, repo_root, resolved_via FROM repositories WHERE cwd = ?")
      .get(sub) as { kind: string; repo_root: string; resolved_via: string };
    expect({ ...renamed, repo_root: slash(renamed.repo_root) }).toEqual({
      kind: "missing",
      repo_root: slash(repo),
      resolved_via: "last_known",
    });
    rmSync(`${sub}-renamed`, { recursive: true });
  });
});
