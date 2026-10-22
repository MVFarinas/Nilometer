/**
 * @file Repository aliases: a renamed or moved project's old path counts under its new one (D-092,
 * step G4.5).
 *
 * Worked out by hand. Requests and how their working directories resolve (resolver injected):
 *
 * | Request | cwd | Resolves to | Output tokens |
 * |---|---|---|---|
 * | n1 | /work/new | /work/new, a repository | 40 |
 * | n2 | /work/new/sub | /work/new | 10 |
 * | d1 | /old/name | /old/name, last known, no longer on disk | 30 |
 * | o1 | /other | /other, a repository | 5 |
 *
 * Without an alias: /work/new (repository) 2 requests, 50; /old/name (no longer exists) 1, 30;
 * /other 1, 5. With /old/name counting under /work/new: /work/new (repository) 3 requests, 80;
 * /other 1, 5. d1 keeps /old/name as the path it had before the alias.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../../../../core/db/database.js";
import { type RepoResolution, resolveRepositories } from "../../../../core/ingest/attribution.js";
import {
  RepositoryAliasError,
  listAliases,
  normalizeRepositoryPath,
  removeAlias,
  setAlias,
  validateAlias,
} from "../../../../core/plans/repository-aliases.js";
import { explain } from "../../../../viewer/explain.js";
import { loadHtmlData } from "../../../../viewer/html-data.js";
import { renderHtmlReport } from "../../../../viewer/html.js";
import { loadObserved, loadProjected } from "../../../../viewer/queries.js";
import { LABELS, renderReport } from "../../../../viewer/render.js";
import { ingest, now, request } from "../metrics/helpers.js";

/** How each synthetic working directory resolves. */
const RESOLUTIONS: Record<string, RepoResolution> = {
  "/work/new": { kind: "repo", repoRoot: "/work/new" },
  "/work/new/sub": { kind: "repo", repoRoot: "/work/new" },
  "/old/name": { kind: "missing", repoRoot: "/old/name", via: "last_known" },
  "/other": { kind: "repo", repoRoot: "/other" },
};

/**
 * One request in its own session.
 * @param id - Request and session suffix.
 * @param cwd - Working directory.
 * @param output - Output tokens.
 * @param time - `HH:MM` UTC on 2026-09-03.
 * @returns The line.
 */
const at = (id: string, cwd: string, output: number, time: string) =>
  request(`s-${id}`, id, null, `2026-09-03T${time}:00Z`, { cwd, usage: { output_tokens: output } });

/**
 * Builds the scenario's database, with repositories resolved as the table above says.
 * @returns The database.
 */
function scenario(): Db {
  const db = ingest({
    "-work-new/a.jsonl": [
      at("n1", "/work/new", 40, "10:00"),
      at("n2", "/work/new/sub", 10, "11:00"),
    ],
    "-old-name/b.jsonl": [at("d1", "/old/name", 30, "09:00")],
    "-other/c.jsonl": [at("o1", "/other", 5, "12:00")],
  });
  resolveRepositories(
    db,
    now,
    (cwd) => RESOLUTIONS[cwd] ?? { kind: "not_git" },
    (path) => path !== "/old/name",
  );
  return db;
}

/**
 * Reads the repository totals.
 * @param db - The database.
 * @returns `[repository, kind, requests, output tokens]` per row, most output first.
 */
const byRepo = (db: Db) =>
  (
    db
      .prepare(
        "SELECT repository, repo_kind, requests, output_tokens FROM obs_usage_by_repo ORDER BY output_tokens DESC",
      )
      .all() as { repository: string; repo_kind: string; requests: number; output_tokens: number }[]
  ).map((r) => [r.repository, r.repo_kind, r.requests, r.output_tokens]);

/**
 * A fixed clock for entered_at.
 * @returns 2026-10-22 12:00 UTC.
 */
const clock = () => new Date("2026-10-22T12:00:00Z");

describe("validating an alias (D-092)", () => {
  it("expands ~/, drops a trailing separator, and keeps an absolute path as typed", () => {
    expect(normalizeRepositoryPath("~/Projects/app/", "/home/example")).toBe(
      "/home/example/Projects/app",
    );
    expect(normalizeRepositoryPath("  /old/name  ", "/home/example")).toBe("/old/name");
    expect(normalizeRepositoryPath("/", "/home/example")).toBe("/");
    expect(normalizeRepositoryPath("C:/Users/example/app\\", "/home/example")).toBe(
      "C:/Users/example/app",
    );
  });

  it("refuses a relative path and an alias from a path to itself", () => {
    expect(() => validateAlias("old", "/work/new", "/home/example")).toThrow(RepositoryAliasError);
    expect(() => validateAlias("/work/new/", "/work/new", "/home/example")).toThrow(
      /two different paths/,
    );
  });
});

describe("an alias in the repository totals (D-092)", () => {
  let db: Db;
  beforeEach(() => {
    db = scenario();
  });

  it("counts each path apart until an alias is entered", () => {
    expect(byRepo(db)).toEqual([
      ["/work/new", "repo", 2, 50],
      ["/old/name", "missing", 1, 30],
      ["/other", "repo", 1, 5],
    ]);
  });

  it("counts the old path's requests under the new one, as one repository", () => {
    expect(setAlias(db, { from: "/old/name", to: "/work/new" }, clock)).toBeNull();
    expect(byRepo(db)).toEqual([
      ["/work/new", "repo", 3, 80],
      ["/other", "repo", 1, 5],
    ]);
    // d1 keeps the path it had before the alias, so the number traces back (principle 4).
    expect(
      db
        .prepare("SELECT repository, aliased_from FROM obs_usage_events WHERE output_tokens = 30")
        .get(),
    ).toEqual({ repository: "/work/new", aliased_from: "/old/name" });
    expect(listAliases(db)).toEqual([
      { from: "/old/name", to: "/work/new", enteredAt: "2026-10-22T12:00:00.000Z" },
    ]);
  });

  it("lists the moved request in explain by-repo with its old path, and re-sums", () => {
    setAlias(db, { from: "/old/name", to: "/work/new" }, clock);
    const group = explain(db, "by-repo").groups.find((g) => g.title.startsWith("/work/new"));
    expect(group?.events).toHaveLength(3);
    expect(group?.events.filter((e) => e.description.includes("alias"))).toHaveLength(1);
    expect(group?.events.find((e) => e.description.includes("alias"))?.description).toContain(
      "counted here by the alias from /old/name",
    );
    // Output tokens are the third measure: 40 + 10 + 30 = 80.
    const output = (group?.events ?? []).reduce((sum, e) => sum + (e.contributions[2] ?? 0), 0);
    expect(output).toBe(80);
  });

  it("names the alias under the repository table and the chart, as the user's link", () => {
    setAlias(db, { from: "/old/name", to: "/work/new" }, clock);
    const text = renderReport({
      observed: loadObserved(db),
      projected: loadProjected(db),
      timeZone: "UTC",
      lastIngestAt: null,
      databasePath: "/home/example/.local/share/nilometer/usage.db",
      home: "/home/example",
    });
    expect(text).toContain(`  ${LABELS.alias}: /old/name counts under /work/new`);
    const html = renderHtmlReport(
      loadHtmlData(db, { timeZone: "UTC", generatedAt: new Date("2026-09-04T00:00:00Z") }),
    );
    expect(html).toContain(`<p class="sub">${LABELS.alias}: /old/name counts under /work/new</p>`);
  });

  it("replaces an old path's target, and goes back to counting apart when removed", () => {
    setAlias(db, { from: "/old/name", to: "/work/new" }, clock);
    const previous = setAlias(db, { from: "/old/name", to: "/other" }, clock);
    expect(previous?.to).toBe("/work/new");
    expect(byRepo(db)).toEqual([
      ["/work/new", "repo", 2, 50],
      ["/other", "repo", 2, 35],
    ]);
    expect(removeAlias(db, "/old/name").to).toBe("/other");
    expect(byRepo(db)).toEqual([
      ["/work/new", "repo", 2, 50],
      ["/old/name", "missing", 1, 30],
      ["/other", "repo", 1, 5],
    ]);
    expect(() => removeAlias(db, "/old/name")).toThrow(/no alias for \/old\/name/);
  });

  it("refuses a path with no recorded request, and a chain of aliases", () => {
    expect(() => setAlias(db, { from: "/never/used", to: "/work/new" }, clock)).toThrow(
      /no Claude Code request is recorded under \/never\/used/,
    );
    setAlias(db, { from: "/old/name", to: "/work/new" }, clock);
    // /work/new already takes /old/name; moving /work/new too would chain.
    expect(() => setAlias(db, { from: "/work/new", to: "/other" }, clock)).toThrow(
      /aliases go one step: \/old\/name already counts under \/work\/new/,
    );
    // Pointing /other at /old/name, itself moved, would chain the other way.
    expect(() => setAlias(db, { from: "/other", to: "/old/name" }, clock)).toThrow(
      /aliases go one step/,
    );
    // The old path still counts as recorded after the alias moved it, so it can be re-pointed.
    expect(setAlias(db, { from: "/old/name", to: "/other" }, clock)?.to).toBe("/work/new");
  });
});
