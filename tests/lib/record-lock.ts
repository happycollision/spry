import { join } from "node:path";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";

/**
 * Cross-process advisory lock for record-mode actors that mutate REPO-WIDE
 * state on the shared `happycollision/spry-check` repo.
 *
 * Most record-mode doc tests no longer need it: each fixture test runs in its
 * own namespace (per-test trunk + branch prefix, see `setupDocRepo`), so they
 * are mutually independent and record in parallel. The lock serializes the
 * remaining repo-wide actors — the once-per-process suite-start `reset()` and
 * the canonical land test's default-branch ff-push + baseline restore (see
 * `withGitHubFixture`). Without it, a repo-wide op from one process could
 * bulldoze another process's in-flight work.
 *
 * When an exclusive body IS wrapped, the critical section is its ENTIRE body
 * — the `sp` invocation, the assertions, and the trailing main-restore — not
 * just the mutation itself.
 *
 * Only record mode serializes. Offline replay never touches GitHub and must
 * stay fully parallel, so replay callers simply don't wrap (see
 * `withGitHubFixture`).
 *
 * Mechanism: `mkdir` of a lock directory is atomic across processes (it fails
 * with EEXIST if the directory already exists), which makes it a portable
 * mutual-exclusion primitive without any lockfile-library dependency. A holder
 * writes an `owner.json` meta file naming its pid + timestamp so a crashed
 * holder's lock can be reclaimed as stale rather than wedging the suite.
 */

export interface RecordLockOptions {
  /** Directory under which lock dirs are created. Defaults to `.test-tmp/locks`. */
  dir?: string;
  /** Poll interval while waiting to acquire, in ms. */
  pollMs?: number;
  /**
   * A lock older than this (by its meta timestamp) whose owner pid is no longer
   * alive is considered stale and forcibly broken. Defaults to 5 minutes — long
   * enough that a legitimately slow test (CI waits) is never mistaken for dead.
   */
  staleMs?: number;
  /** Overall acquire timeout, in ms. Throws if the lock can't be taken in time. */
  timeoutMs?: number;
}

const DEFAULT_DIR = join(import.meta.dir, "../../.test-tmp/locks");
const DEFAULT_POLL_MS = 100;
const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Resolve the lock directory for a given key. Exported for tests. */
export function __lockDirFor(dir: string, key: string): string {
  // Sanitize the key into a safe single path segment.
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dir, `${safe}.lock`);
}

interface OwnerMeta {
  pid: number;
  ts: number;
}

/** True if a process with the given pid is currently alive. */
function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Try to acquire the lock once. Returns true on success, false if it's held by
 * a live, non-stale owner.
 */
async function tryAcquire(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    await mkdir(lockDir, { recursive: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

    // Someone holds it. Decide whether it's stale (dead owner + old).
    if (await isStale(lockDir, staleMs)) {
      await rm(lockDir, { recursive: true, force: true });
      // Race: another waiter may reclaim first — retry the mkdir.
      try {
        await mkdir(lockDir, { recursive: false });
      } catch (retryErr) {
        if ((retryErr as NodeJS.ErrnoException).code !== "EEXIST") throw retryErr;
        return false;
      }
    } else {
      return false;
    }
  }

  // We created the dir — stamp ownership.
  const meta: OwnerMeta = { pid: process.pid, ts: Date.now() };
  await writeFile(join(lockDir, "owner.json"), JSON.stringify(meta));
  return true;
}

/** True if the lock dir is held by a dead owner (or unreadable) and old enough. */
async function isStale(lockDir: string, staleMs: number): Promise<boolean> {
  let meta: OwnerMeta | undefined;
  try {
    meta = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf-8")) as OwnerMeta;
  } catch {
    // No meta yet (race between mkdir and writeFile) or corrupt — fall back to
    // the dir's own mtime for the age check, and treat owner as unknown/dead.
    meta = undefined;
  }

  const age = meta
    ? Date.now() - meta.ts
    : await stat(lockDir)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);

  if (age < staleMs) return false;
  // Old enough. If we know the owner pid and it's alive, it's not stale.
  if (meta && isPidAlive(meta.pid)) return false;
  return true;
}

/**
 * Acquire the lock for `key`, run `body`, and release the lock — even if `body`
 * throws. Concurrent callers with the same key are serialized; different keys
 * are independent.
 */
export async function withRecordLock<T>(
  key: string,
  options: RecordLockOptions,
  body: () => Promise<T>,
): Promise<T> {
  const dir = options.dir ?? DEFAULT_DIR;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await mkdir(dir, { recursive: true });
  const lockDir = __lockDirFor(dir, key);

  const deadline = Date.now() + timeoutMs;
  while (!(await tryAcquire(lockDir, staleMs))) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms acquiring record lock "${key}" (${lockDir}). ` +
          `Another test may be wedged; remove the lock dir to recover.`,
      );
    }
    await Bun.sleep(pollMs);
  }

  try {
    return await body();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
