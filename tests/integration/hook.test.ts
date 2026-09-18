/**
 * @file Black-box tests for hooks/statusline.sh (docs/development.md P1.1, D-008, D-018).
 *
 * The hook is POSIX shell, so coverage tooling can't see inside it. Every behavior is tested by
 * spawning the real script under /bin/sh with controlled stdin, data directory, and TMPDIR. On Windows
 * it runs under Git for Windows' `sh`, and tests that need file modes or symbolic links skip (D-049).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CAN_SYMLINK, HAS_POSIX_MODES, SH } from "../setup/platform.js";

/** Absolute path of the hook under test. */
const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../../hooks/statusline.sh");

/** A realistic, synthetic status line payload (no real paths or IDs). */
const PAYLOAD = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/statusline/payload.json"),
);

/** The shape of one spool line written by the hook. */
interface SpoolLine {
  /** Capture time, whole epoch seconds. */
  readonly captured_at_s: number;
  /** Spool line format version. */
  readonly hook_version: number;
  /** Base64 of the exact stdin bytes. */
  readonly payload_b64: string;
}

/** Result of one hook run. */
interface HookRun {
  /** Raw stdout bytes. */
  readonly stdout: Buffer;
  /** Raw stderr bytes. */
  readonly stderr: Buffer;
  /** Exit code; null only if the process was killed by a signal. */
  readonly exitCode: number | null;
}

/** Options for {@link runHook}. */
interface RunOptions {
  /** Data directory argument; omitted from argv when undefined. */
  readonly dataDir?: string;
  /** Directory used as TMPDIR, so temp-file cleanup can be checked. */
  readonly tmpDir?: string;
}

/**
 * Creates a fresh, empty directory for one test.
 * @returns Absolute path of the new directory.
 */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "aua-hook-test-"));
}

/**
 * Creates a data directory, optionally recording a wrapped command the way `init` will.
 * @param wrapped - Original statusLine command to record, or undefined for none.
 * @returns Absolute path of the data directory.
 */
function makeDataDir(wrapped?: string): string {
  const dir = join(freshDir(), "data");
  mkdirSync(dir);
  if (wrapped !== undefined) {
    writeFileSync(join(dir, "wrapped-command"), wrapped);
  }
  return dir;
}

/**
 * Runs the hook synchronously under the POSIX shell ({@link SH}).
 * @param input - Bytes to send on stdin.
 * @param options - Data directory and TMPDIR to use.
 * @returns Captured stdout, stderr, and exit code.
 */
function runHook(input: Buffer | string, options: RunOptions = {}): HookRun {
  const args = options.dataDir === undefined ? [HOOK] : [HOOK, options.dataDir];
  const result = spawnSync(SH, args, {
    input,
    env: { ...process.env, TMPDIR: options.tmpDir ?? tmpdir() },
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

/**
 * Reads and parses every line of a data directory's spool file.
 * @param dataDir - The data directory the hook wrote to.
 * @returns Parsed spool lines in file order; empty if the spool doesn't exist.
 * @throws {SyntaxError} If a line isn't valid JSON, which fails the calling test.
 */
function readSpool(dataDir: string): SpoolLine[] {
  const path = join(dataDir, "statusline.spool.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  // Every line, including the last, must end in exactly one newline.
  expect(text.endsWith("\n")).toBe(true);
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as SpoolLine);
}

/**
 * Decodes the payload bytes stored in a spool line.
 * @param line - A parsed spool line.
 * @returns The exact bytes the hook received on stdin.
 */
function decode(line: SpoolLine): Buffer {
  return Buffer.from(line.payload_b64, "base64");
}

// Each test here starts several real CLI processes, and Node plus tsx plus coverage instrumentation
// costs a second or two per start. Vitest's 5-second default timed this file out on a loaded
// machine while nothing was wrong (D-051), and CI runners are slower than a laptop.
vi.setConfig({ testTimeout: 60_000 });

describe("payload capture", () => {
  const cases: [string, Buffer][] = [
    ["a realistic payload", PAYLOAD],
    ["trailing newlines", Buffer.from('{"a":1}\n\n\n')],
    ["invalid JSON", Buffer.from("this is not json")],
    ["multi-line Unicode", Buffer.from('{"x":"café"}\n{"y":"日本"}')],
    ["empty stdin", Buffer.alloc(0)],
    ["bytes 1 to 255", Buffer.from(Array.from({ length: 255 }, (_, i) => i + 1))],
  ];

  it.each(cases)("stores %s byte-for-byte", (_name, input) => {
    const dataDir = makeDataDir();
    runHook(input, { dataDir });
    const lines = readSpool(dataDir);
    expect(lines).toHaveLength(1);
    expect(decode(lines[0]!).equals(input)).toBe(true);
  });
});

describe("spool line", () => {
  it("has an integer capture time within 5 seconds of now and hook_version 1", () => {
    const dataDir = makeDataDir();
    const before = Math.floor(Date.now() / 1000);
    runHook(PAYLOAD, { dataDir });
    const [line] = readSpool(dataDir);
    expect(Number.isInteger(line!.captured_at_s)).toBe(true);
    expect(Math.abs(line!.captured_at_s - before)).toBeLessThanOrEqual(5);
    expect(line!.hook_version).toBe(1);
    expect(Object.keys(line!).sort()).toEqual(["captured_at_s", "hook_version", "payload_b64"]);
  });

  it("appends without truncating existing lines", () => {
    const dataDir = makeDataDir();
    runHook("first", { dataDir });
    runHook("second", { dataDir });
    runHook("third", { dataDir });
    expect(readSpool(dataDir).map((line) => decode(line).toString())).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("creates a missing data directory", () => {
    const dataDir = join(freshDir(), "not", "yet", "there");
    const run = runHook(PAYLOAD, { dataDir });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.length).toBe(0);
    expect(readSpool(dataDir)).toHaveLength(1);
  });
});

describe("passthrough of the wrapped command", () => {
  it("passes stdout through byte-for-byte, including ANSI, multiple lines, no final newline", () => {
    const expected = "\u001b[32mSonnet 5\u001b[0m ctx 42%\nsecond line";
    const dataDir = makeDataDir(
      `cat >/dev/null; printf '\\033[32mSonnet 5\\033[0m ctx 42%%\\nsecond line'`,
    );
    const run = runHook(PAYLOAD, { dataDir });
    expect(run.stdout.toString()).toBe(expected);
  });

  it("gives the wrapped command the exact stdin bytes", () => {
    const dataDir = makeDataDir("cat");
    const run = runHook(PAYLOAD, { dataDir });
    expect(run.stdout.equals(PAYLOAD)).toBe(true);
  });

  it("passes the wrapped command's stderr through", () => {
    const dataDir = makeDataDir("echo wrapped-warning >&2");
    expect(runHook(PAYLOAD, { dataDir }).stderr.toString()).toBe("wrapped-warning\n");
  });

  it.each([0, 1, 3])("passes exit code %i through", (code) => {
    const dataDir = makeDataDir(`cat >/dev/null; exit ${code}`);
    expect(runHook(PAYLOAD, { dataDir }).exitCode).toBe(code);
  });

  it("still records the payload when the wrapped command fails", () => {
    const dataDir = makeDataDir("exit 2");
    runHook(PAYLOAD, { dataDir });
    expect(readSpool(dataDir)).toHaveLength(1);
  });

  it("reports a wrapped command that doesn't exist through sh's own exit code and message", () => {
    const dataDir = makeDataDir("definitely-not-a-real-command-xyz");
    const run = runHook(PAYLOAD, { dataDir });
    expect(run.exitCode).toBe(127);
    expect(run.stdout.length).toBe(0);
    // The hook adds nothing; the message comes from sh running the wrapped command.
    expect(run.stderr.toString()).toContain("definitely-not-a-real-command-xyz");
  });
});

describe("no wrapped command", () => {
  it("prints the model display name as the minimal default and exits 0", () => {
    const run = runHook(PAYLOAD, { dataDir: makeDataDir() });
    expect(run.stdout.toString()).toBe("Sonnet 5\n");
    expect(run.exitCode).toBe(0);
  });

  it("prints nothing when the payload has no display name", () => {
    const run = runHook('{"model":{}}', { dataDir: makeDataDir() });
    expect(run.stdout.length).toBe(0);
    expect(run.exitCode).toBe(0);
  });

  it("passes through without recording when no data directory is given", () => {
    const tmpDir = freshDir();
    const run = runHook(PAYLOAD, { tmpDir });
    expect(run.stdout.toString()).toBe("Sonnet 5\n");
    expect(run.exitCode).toBe(0);
    expect(readdirSync(tmpDir)).toEqual([]);
  });
});

describe("never fails", () => {
  it("keeps stdout, exit code, and silent stderr when the data directory can't be created", () => {
    // A regular file in the path makes `mkdir -p` fail for the data directory and its error log.
    const blocker = join(freshDir(), "a-file");
    writeFileSync(blocker, "not a directory");
    const dataDir = join(blocker, "data");
    const run = runHook(PAYLOAD, { dataDir });
    expect(run.stdout.toString()).toBe("Sonnet 5\n");
    expect(run.exitCode).toBe(0);
    expect(run.stderr.length).toBe(0);
  });

  it.skipIf(!HAS_POSIX_MODES)(
    "creates the data directory and spool owner-only, whatever the caller's umask (D-043)",
    () => {
      const dataDir = join(freshDir(), "new-data");
      const run = runHook(PAYLOAD, { dataDir });
      expect(run.exitCode).toBe(0);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dataDir, "statusline.spool.jsonl")).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(!CAN_SYMLINK)(
    "refuses to append through a symlinked spool, recording the refusal and keeping the status bar",
    () => {
      const dataDir = makeDataDir("printf ok; exit 3");
      const elsewhere = join(freshDir(), "not-nilometer.txt");
      writeFileSync(elsewhere, "untouched\n");
      symlinkSync(elsewhere, join(dataDir, "statusline.spool.jsonl"));
      const run = runHook(PAYLOAD, { dataDir });
      expect(run.stdout.toString()).toBe("ok");
      expect(run.exitCode).toBe(3);
      expect(run.stderr.length).toBe(0);
      expect(readFileSync(elsewhere, "utf8")).toBe("untouched\n");
      expect(readFileSync(join(dataDir, "hook-errors.log"), "utf8")).toMatch(
        /^\d+ spool-symlink-refused\n$/,
      );
    },
  );

  it.skipIf(!CAN_SYMLINK)(
    "refuses a symlinked wrapped-command instead of executing it (D-050)",
    () => {
      // The file's contents are executed, so a link could run a command Nilometer never wrote.
      const dataDir = makeDataDir();
      const elsewhere = join(freshDir(), "not-ours.sh");
      writeFileSync(elsewhere, "printf hijacked");
      symlinkSync(elsewhere, join(dataDir, "wrapped-command"));
      const run = runHook(PAYLOAD, { dataDir });
      // The default output, not the linked command's.
      expect(run.stdout.toString()).toBe("Sonnet 5\n");
      expect(run.exitCode).toBe(0);
      expect(run.stderr.length).toBe(0);
      expect(readFileSync(join(dataDir, "hook-errors.log"), "utf8")).toMatch(
        /^\d+ wrapped-command-symlink-refused\n$/,
      );
      // The payload is still recorded.
      expect(readSpool(dataDir)).toHaveLength(1);
    },
  );

  it.skipIf(!CAN_SYMLINK)("never writes its error log through a symlink either", () => {
    const dataDir = makeDataDir();
    const elsewhere = join(freshDir(), "other.log");
    writeFileSync(elsewhere, "");
    symlinkSync(join(freshDir(), "target"), join(dataDir, "statusline.spool.jsonl"));
    symlinkSync(elsewhere, join(dataDir, "hook-errors.log"));
    const run = runHook(PAYLOAD, { dataDir });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(elsewhere, "utf8")).toBe("");
  });

  it("logs a failed append to hook-errors.log without touching stderr", () => {
    const dataDir = makeDataDir("printf ok; exit 5");
    // A directory where the spool file should be makes the append fail while the log still works.
    mkdirSync(join(dataDir, "statusline.spool.jsonl"));
    const run = runHook(PAYLOAD, { dataDir });
    expect(run.stdout.toString()).toBe("ok");
    expect(run.exitCode).toBe(5);
    expect(run.stderr.length).toBe(0);
    const log = readFileSync(join(dataDir, "hook-errors.log"), "utf8");
    expect(log).toMatch(/^\d+ append-failed\n$/);
  });

  // A read-only TMPDIR needs POSIX modes.
  it.skipIf(!HAS_POSIX_MODES)(
    "passes the payload to the wrapped command even when no temp file can be created",
    () => {
      const tmpDir = freshDir();
      // A read-only TMPDIR makes mktemp fail.
      chmodSync(tmpDir, 0o500);
      const dataDir = makeDataDir("cat");
      const run = runHook(PAYLOAD, { dataDir, tmpDir });
      chmodSync(tmpDir, 0o700);
      expect(run.stdout.equals(PAYLOAD)).toBe(true);
      expect(run.exitCode).toBe(0);
      expect(run.stderr.length).toBe(0);
    },
  );

  it.skipIf(!HAS_POSIX_MODES)(
    "exits 0 with no output when no temp file can be created and nothing is wrapped",
    () => {
      const tmpDir = freshDir();
      chmodSync(tmpDir, 0o500);
      const run = runHook(PAYLOAD, { dataDir: makeDataDir(), tmpDir });
      chmodSync(tmpDir, 0o700);
      expect(run.exitCode).toBe(0);
      expect(run.stdout.length).toBe(0);
      expect(run.stderr.length).toBe(0);
    },
  );
});

describe("cleanup", () => {
  it.each([
    ["success", "cat >/dev/null"],
    ["a failing wrapped command", "exit 9"],
  ])("leaves no temp file after %s", (_name, wrapped) => {
    const tmpDir = freshDir();
    runHook(PAYLOAD, { dataDir: makeDataDir(wrapped), tmpDir });
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it("leaves no temp file after a failed append", () => {
    const tmpDir = freshDir();
    const dataDir = makeDataDir();
    mkdirSync(join(dataDir, "statusline.spool.jsonl"));
    runHook(PAYLOAD, { dataDir, tmpDir });
    expect(readdirSync(tmpDir)).toEqual([]);
  });
});

describe("concurrency", () => {
  // Git for Windows starts processes slowly: 20 at once can take several seconds there.
  it("records one valid line per run when 20 hooks run at once", { timeout: 60_000 }, async () => {
    const dataDir = makeDataDir("cat >/dev/null");
    const runs = Array.from(
      { length: 20 },
      (_, i) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(SH, [HOOK, dataDir]);
          child.on("close", resolve);
          child.stdin.end(`{"run":${i}}`);
        }),
    );
    expect(await Promise.all(runs)).toEqual(Array(20).fill(0));
    const payloads = readSpool(dataDir).map((line) => decode(line).toString());
    expect(payloads.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `{"run":${i}}`).sort());
  });
});
