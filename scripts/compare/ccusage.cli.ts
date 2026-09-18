/**
 * @file Command-line entry point for `npm run compare:ccusage` (audit check A7). Holds no logic, so
 * it is excluded from coverage; everything it runs is tested through `main()` in ccusage.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultDeps, main } from "./ccusage.js";

process.exitCode = await main(
  join(dirname(fileURLToPath(import.meta.url)), "../../fixtures"),
  defaultDeps(),
);
