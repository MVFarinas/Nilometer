/**
 * @file Command-line entry point for the install rehearsal: `tsx scripts/install/rehearse.cli.ts
 * <tarball>`. Holds no logic, so it is excluded from coverage; everything it runs is tested through
 * `rehearse()` in rehearse.ts.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rehearse, spawnRun } from "./rehearse.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tarball = process.argv[2];
if (tarball === undefined) {
  console.error("usage: tsx scripts/install/rehearse.cli.ts <tarball from npm pack>");
  process.exitCode = 2;
} else {
  const { ok } = rehearse({
    tarball: resolve(tarball),
    home: mkdtempSync(join(tmpdir(), "nilometer-rehearsal-")),
    projects: join(root, "fixtures", "08-limit-hits", "projects"),
    payload: readFileSync(join(root, "tests", "fixtures", "statusline", "payload.json")),
    platform: process.platform,
    baseEnv: process.env,
    run: spawnRun,
    print: (line) => {
      console.log(line);
    },
  });
  process.exitCode = ok ? 0 : 1;
}
