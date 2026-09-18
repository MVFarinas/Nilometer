/**
 * @file Command-line entry point for `npm run audit`. Holds no logic, so it is excluded from
 * coverage; everything it runs is tested through `main()` in run.ts.
 */
import { defaultDeps, main } from "./run.js";

process.exitCode = main(defaultDeps());
