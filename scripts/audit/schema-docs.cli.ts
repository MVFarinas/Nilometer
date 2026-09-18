/**
 * @file Command-line entry point for the schema documentation check (A5). Holds no logic, so it is
 * excluded from coverage; everything it runs is tested through `main()` in schema-docs.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultDeps, main } from "./schema-docs.js";

process.exitCode = main(
  join(dirname(fileURLToPath(import.meta.url)), "../../core/schema"),
  defaultDeps(),
);
