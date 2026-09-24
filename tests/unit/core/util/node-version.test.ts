/**
 * @file Unit tests for core/util/node-version.ts, and for how the entry point uses it (D-066).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REQUIREMENTS_DOC,
  SUPPORTED_NODE_MAJOR,
  checkNodeVersion,
} from "../../../../core/util/node-version.js";

/** Repository root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Reads a file from the repository root.
 * @param path - Path relative to the root.
 * @returns The file's text.
 */
function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("checkNodeVersion", () => {
  it("accepts every release of the supported major, and says nothing", () => {
    for (const version of ["24.0.0", "24.12.0", "24.21.0"]) {
      expect(checkNodeVersion(version)).toEqual({ status: "ok", message: undefined });
    }
  });

  it("stops an older major with a message naming both versions and the guide", () => {
    // 22.11.0 is the version observed to segfault on opening the database.
    for (const version of ["22.11.0", "23.11.1", "18.20.4"]) {
      const check = checkNodeVersion(version);
      expect(check.status).toBe("too_old");
      expect(check.message).toContain(`Node.js ${version}`);
      expect(check.message).toContain(`Nilometer needs Node.js 24`);
      expect(check.message).toContain(REQUIREMENTS_DOC);
      expect(check.message).toContain("Nothing was changed.");
    }
  });

  it("lets a newer major run, with a warning that it isn't tested", () => {
    for (const version of ["25.9.0", "26.10.0"]) {
      const check = checkNodeVersion(version);
      expect(check.status).toBe("newer");
      expect(check.message).toContain(`Node.js ${version}`);
      expect(check.message).toContain("aren't tested");
      expect(check.message).toContain(REQUIREMENTS_DOC);
    }
  });

  it("reads a leading v the same way, as process.version writes it", () => {
    expect(checkNodeVersion("v24.21.0").status).toBe("ok");
    expect(checkNodeVersion("v22.11.0").status).toBe("too_old");
  });

  it("warns without stopping when the version can't be read", () => {
    for (const version of ["", "24", "not-a-version"]) {
      const check = checkNodeVersion(version);
      expect(check.status).toBe("unrecognized");
      expect(check.message).toContain(REQUIREMENTS_DOC);
    }
  });

  it("prints only ASCII, like everything else the tool prints (D-063)", () => {
    for (const version of ["22.11.0", "26.10.0", "?"]) {
      // Printable ASCII only: a space through a tilde.
      expect(checkNodeVersion(version).message).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("the supported major matches everything else that states it", () => {
  it("equals the major in .nvmrc", () => {
    expect(read(".nvmrc").trim()).toBe(String(SUPPORTED_NODE_MAJOR));
  });

  it("equals the range in package.json engines", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${SUPPORTED_NODE_MAJOR} <${SUPPORTED_NODE_MAJOR + 1}`);
  });

  it("points at a guide that exists", () => {
    expect(read(REQUIREMENTS_DOC)).toContain(`Node.js ${SUPPORTED_NODE_MAJOR}`);
  });
});

describe("the entry point", () => {
  const entry = read("cli/main.cli.ts");

  it("checks the version before loading the program", () => {
    // A static import is evaluated before any statement in the file, so an older Node.js would
    // load the program, and the native module behind it, before the check could stop it.
    expect(entry).not.toMatch(/^import .* from "\.\/program\.js";$/m);
    expect(entry).not.toMatch(/^import .* from "\.\.\/core\/install\/locations\.js";$/m);
    const checkAt = entry.indexOf("checkNodeVersion(process.versions.node)");
    const loadAt = entry.indexOf('await import("./program.js")');
    expect(checkAt).toBeGreaterThan(0);
    expect(loadAt).toBeGreaterThan(checkAt);
  });
});
