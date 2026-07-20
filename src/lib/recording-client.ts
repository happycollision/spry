import { writeCassette } from "./cassette.ts";
import type { CommandResult, CommandOptions, GitRunner } from "./context.ts";
import type { CassetteEntry } from "./cassette.ts";

export interface RecordingClient extends GitRunner {
  flush(): Promise<void>;
}

/**
 * Anchored patterns that unambiguously reference a GitHub PR number:
 * `pull/<n>` in URLs and `"number":<n>` in JSON payloads. Deliberately NOT a
 * bare numeric replace — fields like `"totalCount":<n>` would collide.
 */
const PR_NUMBER_PATTERN = /(pull\/|"number":)(\d+)/g;

/**
 * Normalize GitHub-minted PR numbers to a deterministic sequence (1001,
 * 1002, ... in first-seen order) so re-recording a cassette against the live
 * repo produces byte-identical output.
 *
 * The map is built from anchored matches in recorded stdout/stderr, then
 * applied simultaneously (one pass, so overlapping real/normalized ranges
 * cannot cascade) to:
 *
 * - stdout/stderr — where the numbers are minted;
 * - args — a replay MATCH KEY: the CLI derives argv tokens like
 *   `pr edit <n>` by parsing an earlier entry's (normalized) stdout, so a
 *   recorded bare-numeric arg that names a seen PR must be rewritten in step;
 * - stdin — the other match key, same reasoning, via the anchored patterns.
 *
 * Accepted limits (each fails LOUD, never silently):
 *
 * - A whole-numeric arg unrelated to any PR (e.g. `--limit 1084`) is
 *   rewritten if it happens to equal a seen PR number. The replay-time call
 *   still carries the real value, so the args-keyed replayer throws
 *   "No matching recorded entry" — a visible failure, not a silent mismatch.
 * - The map is per-cassette: PR numbers are assumed never to cross cassette
 *   files. Each doc fragment records its own cassette from a reset repo
 *   state; a cross-cassette reference would surface as a loud replay miss.
 * - `"number":<n>` matches gh's compact JSON only (no space after the
 *   colon). If gh ever pretty-prints, those numbers stop being normalized
 *   and re-record churn returns — caught by the pre-merge gate's
 *   clean-status check.
 */
export function normalizePRNumbers(entries: CassetteEntry[]): CassetteEntry[] {
  const normalized = new Map<string, string>();
  let next = 1001;
  for (const entry of entries) {
    for (const text of [entry.result.stdout, entry.result.stderr]) {
      for (const match of text.matchAll(PR_NUMBER_PATTERN)) {
        const real = match[2];
        if (real !== undefined && !normalized.has(real)) {
          normalized.set(real, String(next++));
        }
      }
    }
  }

  const rewrite = (text: string): string =>
    text.replace(PR_NUMBER_PATTERN, (full, prefix: string, real: string) => {
      const replacement = normalized.get(real);
      return replacement === undefined ? full : prefix + replacement;
    });

  const rewriteArg = (arg: string): string =>
    /^\d+$/.test(arg) ? (normalized.get(arg) ?? arg) : rewrite(arg);

  return entries.map((entry) => ({
    args: entry.args.map(rewriteArg),
    ...(entry.options === undefined
      ? {}
      : {
          options:
            entry.options.stdin === undefined
              ? entry.options
              : { ...entry.options, stdin: rewrite(entry.options.stdin) },
        }),
    result: {
      ...entry.result,
      stdout: rewrite(entry.result.stdout),
      stderr: rewrite(entry.result.stderr),
    },
  }));
}

/**
 * Keep only `stdin` from the recorded options: it is the sole option the
 * args-keyed replayer matches on. Everything else (`cwd` temp paths, `env`)
 * is per-run noise that would churn the committed cassette.
 */
function persistedOptions(options: CommandOptions | undefined): CommandOptions | undefined {
  if (options?.stdin === undefined) return undefined;
  return { stdin: options.stdin };
}

export function createRecordingClient(inner: GitRunner, cassettePath: string): RecordingClient {
  const entries: CassetteEntry[] = [];

  const persist = () => writeCassette(cassettePath, { entries: normalizePRNumbers(entries) });

  return {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      const result = await inner.run(args, options);
      const persisted = persistedOptions(options);
      entries.push(
        persisted === undefined ? { args, result } : { args, options: persisted, result },
      );
      // Persist after every call so a recording survives a command that
      // process.exit()s before the seam's flush() in finally can run.
      await persist();
      return result;
    },
    async flush(): Promise<void> {
      await persist();
    },
  };
}
