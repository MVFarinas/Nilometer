/**
 * @file Command-line entry point for `npm run fixtures`. Holds no logic, so it is excluded from
 * coverage; everything it runs is tested through `main()` in generate.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "./generate.js";

main(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures"), (line) => {
  console.log(line);
});
