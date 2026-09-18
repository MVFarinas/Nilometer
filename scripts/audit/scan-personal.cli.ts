/**
 * @file Command-line entry point for the personal-data scan. Holds no logic, so it is excluded
 * from coverage; everything it runs is tested through `main()` in scan-personal.ts.
 */
import { defaultDeps, main } from "./scan-personal.js";

process.exitCode = main(defaultDeps());
