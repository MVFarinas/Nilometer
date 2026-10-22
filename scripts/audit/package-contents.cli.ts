/**
 * @file Command-line entry point for the package contents check (A23). Holds no logic, so it is
 * excluded from coverage; everything it runs is tested through `main()` in package-contents.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultDeps, main } from "./package-contents.js";

process.exitCode = main(defaultDeps(join(dirname(fileURLToPath(import.meta.url)), "../..")));
