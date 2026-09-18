/**
 * @file Command-line entry point for the loader fidelity check (A6c). Holds no logic, so it is
 * excluded from coverage; everything it runs is tested through `main()` in loader-check.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./loader-check.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
process.exitCode = main(join(root, "fixtures"), join(root, "core/schema"), (line) => {
  console.log(line);
});
