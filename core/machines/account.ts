/**
 * @file Which Claude account a machine is logged in to, as a hash (D-103, step G7.1).
 *
 * Machines are combined only when they're on the same account: the windows are per account, and
 * merging another account's usage would put it in the wrong percentages. The session logs don't
 * record the account (spike G7.0: `ownerAccountUuid` appeared in 3 of 442 files, only inside tool
 * output text), so it's read from Claude Code's own config file, where the login stores it as
 * `oauthAccount.accountUuid`. Only a hash leaves this module, and only the hash goes in the folder.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isObject } from "../ingest/classify.js";
import { expandHome } from "../util/paths.js";

/** The hash's prefix: it ties the hash to this use, so it can't be matched against an ID hashed elsewhere. */
const HASH_PREFIX = "nilometer/account/v1:";

/** What reading the account found. */
export type AccountRead =
  | { readonly kind: "ok"; readonly accountHash: string }
  | { readonly kind: "none"; readonly reason: string };

/**
 * Hashes an account ID for the folder.
 * @param accountUuid - `oauthAccount.accountUuid`.
 * @returns Lowercase hex SHA-256 of the prefixed ID.
 */
export function hashAccount(accountUuid: string): string {
  return createHash("sha256")
    .update(HASH_PREFIX + accountUuid, "utf8")
    .digest("hex");
}

/**
 * Where Claude Code keeps its config file: in `CLAUDE_CONFIG_DIR` when that's set (its first entry,
 * as Claude Code reads it), else `~/.claude.json`.
 * @param env - The environment.
 * @param env.CLAUDE_CONFIG_DIR - Claude Code's config directory, if set.
 * @param home - The home directory.
 * @returns The config file's path.
 */
export function claudeConfigPath(
  env: { readonly CLAUDE_CONFIG_DIR?: string | undefined },
  home: string,
): string {
  const first = env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  return first === undefined || first === ""
    ? join(home, ".claude.json")
    : join(expandHome(first, home), ".claude.json");
}

/**
 * Reads the logged-in account from Claude Code's config, keeping only its hash.
 * @param path - The config file, from {@link claudeConfigPath}.
 * @param read - File reader, injectable for tests.
 * @returns The hash, or why there is none (no file, not JSON, or no logged-in account).
 */
export function readAccount(
  path: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): AccountRead {
  let text: string;
  try {
    text = read(path);
  } catch {
    return { kind: "none", reason: "Claude Code's config file wasn't found" };
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return { kind: "none", reason: "Claude Code's config file isn't valid JSON" };
  }
  const account = isObject(config) ? config["oauthAccount"] : null;
  const uuid = isObject(account) ? account["accountUuid"] : null;
  // An API key login, or a logged-out Claude Code, has no account here: nothing to match on.
  if (typeof uuid !== "string" || uuid === "") {
    return { kind: "none", reason: "Claude Code isn't logged in to a Claude account here" };
  }
  return { kind: "ok", accountHash: hashAccount(uuid) };
}
