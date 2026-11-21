/**
 * @file Vitest configuration: test discovery and the coverage thresholds from docs/development.md § Testing
 * (audit check A4). Lowering a threshold requires an ADR.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Every scratch directory tests create lands under one run-scoped root that is removed at the end.
    globalSetup: ["tests/setup/temp-root.ts"],
    // A committed `.only` must fail the run everywhere, not only in CI.
    allowOnly: false,
    // Windows CI runners run database-building tests 5-10x slower than a Mac, and four files in turn
    // timed out at Vitest's 5-second default with every result right (D-051, D-105). There every test
    // takes the integration limit; macOS and Linux keep the default, so a test that really slows down
    // still fails somewhere.
    ...(process.platform === "win32" ? { testTimeout: 60_000 } : {}),
    coverage: {
      provider: "v8",
      // Listing sources explicitly makes a file with no tests count as 0% rather than vanish.
      include: [
        "core/**/*.ts",
        "hooks/**/*.ts",
        "viewer/**/*.ts",
        "cli/**/*.ts",
        "scripts/**/*.ts",
      ],
      // Spikes are throwaway (P0.3). `*.cli.ts` entry points are one line calling a tested main().
      exclude: ["scripts/spikes/**", "**/*.cli.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        functions: 100,
        lines: 95,
        statements: 95,
        branches: 90,
      },
    },
  },
});
