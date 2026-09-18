/**
 * @file Personal-data scan over the repository tree (audit check A10, docs/development.md § Audits).
 *
 * CLAUDE.md forbids committing machine-specific paths and personal context. Secrets are
 * gitleaks' job; this scan catches what gitleaks does not look for: home-directory paths that
 * reveal a username and machine layout. Findings are printed with the username redacted, so the
 * scan's own output is safe to paste into an audit record or a CI log.
 *
 * A line can opt out with the marker {@link ALLOW_MARKER}, for tests that must contain a
 * realistic path to prove the scan detects it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** One place in one file where personal data was found. */
export interface Finding {
  /** Repository-relative path of the file. */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** ID of the rule that matched, from {@link RULES}. */
  readonly rule: string;
  /** The matching line, trimmed and with the personal part replaced by `<redacted>`. */
  readonly excerpt: string;
}

/** A pattern that identifies personal data. */
export interface Rule {
  /** Stable ID printed in findings. */
  readonly id: string;
  /**
   * Global regex whose first capture group is the personal part (e.g. the username).
   * It must have the `g` flag, because {@link scanText} iterates over every match on a line.
   */
  readonly pattern: RegExp;
}

/** Text that exempts a line from the scan when it appears anywhere on that line. */
export const ALLOW_MARKER = "personal-scan: allow";

/** Usernames that are obviously placeholders, and therefore not personal data. */
export const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(["example"]);

/** The rules applied to every line. */
export const RULES: readonly Rule[] = [
  {
    id: "home-path",
    // macOS, Linux, and Windows home directories, written as /Users/<name>, /home/<name>, and
    // C:\Users\<name>. The character class excludes "<", so placeholders like these pass.
    pattern: /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g,
  },
];

/**
 * Replaces the personal part of every rule match on a line with `<redacted>`.
 *
 * Only the matched path segment is replaced. A name like `x` must not also rewrite the `x` in
 * "Linux", and a second username on the same line must be hidden in every finding's excerpt.
 * @param content - One line of text.
 * @param rules - Rules whose first capture group is the personal part.
 * @returns The line with every non-placeholder captured name replaced.
 */
export function redactLine(content: string, rules: readonly Rule[]): string {
  return rules.reduce(
    (line, rule) =>
      line.replace(rule.pattern, (whole: string, ...rest: unknown[]) => {
        // With a capture group, rest[0] is the captured name. Without one, replace() passes the
        // match offset (a number) in that position, so only a string counts as a name.
        const name = rest[0];
        if (typeof name !== "string" || PLACEHOLDER_NAMES.has(name)) {
          return whole;
        }
        // The pattern ends with the capture group, so the name is the match's tail; swap only it.
        return `${whole.slice(0, whole.length - name.length)}<redacted>`;
      }),
    content,
  );
}

/**
 * Scans one file's text and returns every finding in it.
 * @param path - Repository-relative path, copied into each finding.
 * @param text - The file's full text.
 * @param rules - Rules to apply; defaults to {@link RULES}.
 * @returns Findings in line order; empty when the text is clean.
 */
export function scanText(path: string, text: string, rules: readonly Rule[] = RULES): Finding[] {
  const findings: Finding[] = [];
  // Split on both newline styles so line numbers match what an editor shows.
  const lines = text.split(/\r?\n/);
  lines.forEach((content, index) => {
    // An explicitly allowed line is skipped entirely, whatever it contains.
    if (content.includes(ALLOW_MARKER)) {
      return;
    }
    for (const rule of rules) {
      // matchAll needs a fresh iterator per line; the global flag is what makes this legal.
      for (const match of content.matchAll(rule.pattern)) {
        const name = match[1];
        // A placeholder name is documentation, not a leak.
        if (name === undefined || PLACEHOLDER_NAMES.has(name)) {
          continue;
        }
        findings.push({
          path,
          line: index + 1,
          rule: rule.id,
          // Redact before truncating so a long line can never cut the redaction in half.
          excerpt: redactLine(content, rules).trim().slice(0, 160),
        });
      }
    }
  });
  return findings;
}

/**
 * Reports whether a file's bytes look binary, using the same NUL-byte heuristic as git.
 * @param bytes - The file's contents.
 * @returns `true` if a NUL byte appears in the first 8000 bytes.
 */
export function isBinary(bytes: Uint8Array): boolean {
  // git looks at the first 8000 bytes; matching it keeps "binary" consistent with `git diff`.
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Runs git and returns its stdout. Injected so tests never depend on the real repository.
 * @param args - Arguments to pass to git.
 * @returns git's exit code and stdout text.
 */
export type GitRunner = (args: readonly string[]) => { exitCode: number; stdout: string };

/**
 * Lists every file git would consider part of the tree: tracked files plus untracked files that
 * aren't ignored. New files are scanned before their first commit, which is when a leak can
 * still be stopped.
 * @param git - Runs a git command.
 * @returns Repository-relative paths, in git's order.
 * @throws {Error} If git exits non-zero, so a broken git setup never passes as "no findings".
 */
export function listRepoFiles(git: GitRunner): string[] {
  // -c tracked, -o untracked, --exclude-standard honours .gitignore; -z keeps odd names intact.
  const result = git(["ls-files", "-z", "-c", "-o", "--exclude-standard"]);
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed with exit code ${result.exitCode}`);
  }
  // With -z every entry ends in NUL, so the final empty element is dropped.
  return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

/** Dependencies of {@link main}, injected so the whole flow is testable without a real repo. */
export interface ScanDeps {
  /** Runs git. */
  readonly git: GitRunner;
  /** Reads a file's bytes, or returns `null` if it no longer exists. */
  readonly readFile: (path: string) => Uint8Array | null;
  /** Writes one line of output. */
  readonly print: (line: string) => void;
}

/**
 * Scans the repository and prints the result.
 * @param deps - Git access, file reading, and output.
 * @returns Process exit code: 0 when clean, 1 when any finding exists.
 */
export function main(deps: ScanDeps): number {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const path of listRepoFiles(deps.git)) {
    const bytes = deps.readFile(path);
    // A file listed by git but deleted in the working tree has nothing to scan.
    if (bytes === null || isBinary(bytes)) {
      continue;
    }
    scanned += 1;
    findings.push(...scanText(path, new TextDecoder().decode(bytes)));
  }
  for (const finding of findings) {
    deps.print(`${finding.path}:${finding.line} [${finding.rule}] ${finding.excerpt}`);
  }
  deps.print(`personal-data scan: ${scanned} files scanned, ${findings.length} findings`);
  return findings.length === 0 ? 0 : 1;
}

/**
 * Builds the real dependencies used when the scan runs from the command line.
 * @returns Dependencies backed by git, the filesystem, and stdout.
 */
export function defaultDeps(): ScanDeps {
  return {
    git: (args) => {
      const result = spawnSync("git", args, { encoding: "utf8" });
      // A missing git binary has no exit status; 127 is the shell's "command not found".
      return { exitCode: result.status ?? 127, stdout: result.stdout ?? "" };
    },
    readFile: (path) => {
      try {
        return readFileSync(path);
      } catch {
        // Treat unreadable as absent; git just listed it, so this is a race, not a leak.
        return null;
      }
    },
    print: (line) => {
      console.log(line);
    },
  };
}
