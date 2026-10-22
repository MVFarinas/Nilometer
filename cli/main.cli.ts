#!/usr/bin/env node
/**
 * @file Command-line entry point. Holds no logic, so it is excluded from coverage; everything it
 * runs is tested through `checkNodeVersion()` in node-version.ts, `runCli()` in program.ts, and
 * the CLI integration tests.
 */
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { checkNodeVersion } from "../core/util/node-version.js";

// Checked before the program is imported: on an older Node.js, the built-in `node:sqlite` is missing
// (22.11 throws on import without a flag) or experimental (22.23 warns on every run), and Nilometer
// isn't tested there (D-066, D-093). The program is loaded with a dynamic import below so nothing
// that loads `node:sqlite` runs before this check.
const nodeCheck = checkNodeVersion(process.versions.node);
if (nodeCheck.message !== undefined) {
  console.error(nodeCheck.message);
}

if (nodeCheck.status === "too_old") {
  process.exitCode = 1;
} else {
  const { findPackageRoot } = await import("../core/install/locations.js");
  const { runCli } = await import("./program.js");
  process.exitCode = runCli(process.argv.slice(2), {
    home: homedir(),
    env: process.env,
    packageRoot: findPackageRoot(dirname(fileURLToPath(import.meta.url))),
    now: () => new Date(),
    print: (line) => {
      console.log(line);
    },
    printError: (line) => {
      console.error(line);
    },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}
