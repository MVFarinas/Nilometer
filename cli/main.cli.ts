#!/usr/bin/env node
/**
 * @file Command-line entry point. Holds no logic, so it is excluded from coverage; everything it
 * runs is tested through `runCli()` in program.ts and the CLI integration tests.
 */
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { findPackageRoot } from "../core/install/locations.js";
import { runCli } from "./program.js";

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
