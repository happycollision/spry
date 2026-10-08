import { access, chmod, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { GitRunner } from "../lib/context.ts";

interface Worktree {
  path: string;
  branch?: string;
  detached: boolean;
}

export const htHelp = `Happy Trees — Easier worktree gardening
Usage: sp ht <command> [command-options]

Commands:
  help                  Show help
  list, ls              List linked worktrees and flag ambiguous identities
  checkout, co [branch [base]] [-s|--skip-setup] [-e|--exec <command>] [-E|--no-exec]
                        Create a worktree or run exec in an existing worktree
  remove [branch] [--force]
                        Remove a worktree; delete its local branch only on a remote SHA match
  destroy [branch] [--force]
                        Remove a worktree and its local and origin branches
  setup [--init [path]]  Run setup in a linked worktree or create a setup template

Omitting a branch opens an fzf selector. Checkout lists worktrees first, then
local and origin branches by commit recency. Destroy excludes the default branch.
Destroy refuses dirty or path-mismatched worktrees unless --force is given.

Git configuration (local or --global):
  happy-trees.worktreesDir  Default: <repo_root>/../<repo_name>.worktrees
  happy-trees.defaultBranch  Default: origin/HEAD, origin/main, origin/master, main, master
  happy-trees.exec           Shell command run inside the worktree after checkout
  happy-trees.setupLocation  Executable script receiving repo root and worktree root
  happy-trees.failDestroyOnPathMismatch  Default: true; false disables the path gate

Path tokens: <repo_root>, <repo_name>, and (for setup) <worktree_root>.
Existing worktrees are found by branch regardless of worktreesDir.
Setup runs automatically on creation; -s skips it. -e overrides configured exec;
-E skips exec. Setup and exec failures leave newly created worktrees in place.
Remove compares local and origin SHAs without fetching. --force permits dirty
removal. Destroy always protects the default branch, even with --force.
Removing your current worktree leaves your shell in a stale directory.
For separate Git admin directories without core.worktree, run checkout from the
primary worktree once before using externally created linked worktrees.
`;

export async function htCommand(git: GitRunner, args: string[]): Promise<void> {
  const [raw = "help", ...rest] = args;
  if (["help", "--help", "-h"].includes(raw)) {
    console.log(htHelp);
    return;
  }
  const command = ({ co: "checkout", ls: "list" } as Record<string, string>)[raw] ?? raw;
  if (!["checkout", "list", "remove", "destroy", "setup"].includes(command))
    throw new Error(`Unknown subcommand: ${raw}`);
  const positional: string[] = [];
  let force = false,
    skip = false,
    noExec = false,
    exec = "",
    init: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (command === "checkout" && ["-s", "--skip-setup"].includes(arg)) skip = true;
    else if (command === "checkout" && ["-E", "--no-exec"].includes(arg)) noExec = true;
    else if (command === "checkout" && ["-e", "--exec"].includes(arg)) {
      exec = rest[++i] ?? "";
      if (!exec) throw new Error(`${arg} requires a command`);
    } else if (["remove", "destroy"].includes(command) && arg === "--force") force = true;
    else if (command === "setup" && arg === "--init") {
      init =
        rest[i + 1] && !rest[i + 1]?.startsWith("-")
          ? (rest[++i] ?? "setup-worktree.sh")
          : "setup-worktree.sh";
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > (command === "checkout" ? 2 : command === "setup" ? 0 : 1))
    throw new Error("Too many arguments");
  let repositoryCwd = process.cwd();
  const read = async (a: string[], cwd = repositoryCwd) => git.run(a, { cwd });
  const run = async (a: string[], cwd?: string) => {
    const r = await read(a, cwd);
    if (r.exitCode) throw new Error(r.stderr.trim() || `git ${a[0]} failed`);
    return r.stdout.trim();
  };
  const config = async (key: string, fallback = "") =>
    (await read(["config", `happy-trees.${key}`])).stdout.trim() || fallback;
  const common = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const trees: Worktree[] = (await run(["worktree", "list", "--porcelain", "-z"]))
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\0");
      return {
        path: lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "",
        branch: lines.find((l) => l.startsWith("branch refs/heads/"))?.slice(18),
        detached: lines.includes("detached"),
      };
    });
  const admin = await run(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const rootCache = resolve(common, "spry-ht-primary-root");
  let root: string;
  if ((await run(["rev-parse", "--is-bare-repository"])) === "true") root = common;
  else if (admin === common) root = await run(["rev-parse", "--show-toplevel"]);
  else {
    const configured = (await read(["config", "--get", "core.worktree"])).stdout.trim();
    if (configured) root = resolve(common, configured);
    else if ((await read(["config", "--bool", "core.bare"])).stdout.trim() === "true")
      root = common;
    else {
      // Separate admin directories contain no backlink to the primary working directory.
      const cached: unknown = await Bun.file(rootCache)
        .json()
        .catch(() => undefined);
      if (typeof cached !== "string" && basename(common) === ".git") {
        const candidate = await read(
          ["rev-parse", "--path-format=absolute", "--git-dir", "--show-toplevel"],
          dirname(common),
        );
        const [candidateAdmin, candidateRoot] = candidate.stdout.trim().split("\n");
        if (!candidate.exitCode && candidateAdmin === common && candidateRoot) root = candidateRoot;
        else
          throw new Error(
            "Cannot determine primary working directory. Run sp ht checkout from the primary worktree first.",
          );
      } else if (typeof cached !== "string")
        throw new Error(
          "Cannot determine primary working directory. Run sp ht checkout from the primary worktree first.",
        );
      else {
        const check = await read(["rev-parse", "--path-format=absolute", "--git-dir"], cached);
        if (check.exitCode || check.stdout.trim() !== common)
          throw new Error(
            "Primary worktree path is unavailable. Run sp ht checkout from the primary worktree first.",
          );
        root = cached;
      }
    }
  }
  const primary = trees[0];
  if (primary) primary.path = root;
  const expand = (p: string, wt = "") =>
    p
      .replaceAll("<repo_root>", root)
      .replaceAll("<repo_name>", basename(root))
      .replaceAll("<worktree_root>", wt);
  const exists = async (p: string, executable = false) => {
    try {
      await access(p, executable ? constants.X_OK : constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  const hasLocal = async (b: string) =>
    (await read(["show-ref", "--verify", "--quiet", `refs/heads/${b}`])).exitCode === 0;
  const remoteSha = async (branch: string) => {
    const ref = `refs/heads/${branch}`;
    const result = await read(["ls-remote", "--heads", "origin", ref]);
    if (result.exitCode !== 0) return "";
    for (const line of result.stdout.trim().split("\n")) {
      const [sha, returnedRef] = line.split(/\s+/);
      if (returnedRef === ref && sha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) return sha;
    }
    return "";
  };
  const defaultBranch = async () => {
    const override = await config("defaultBranch");
    if (override) return override;
    const sym = await read(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (!sym.exitCode) return sym.stdout.trim().replace(/^refs\/remotes\//, "");
    for (const ref of [
      "refs/remotes/origin/main",
      "refs/remotes/origin/master",
      "refs/heads/main",
      "refs/heads/master",
    ]) {
      if (!(await read(["show-ref", "--verify", "--quiet", ref])).exitCode)
        return ref.replace(/^refs\/(remotes|heads)\//, "");
    }
    throw new Error("Could not determine default branch");
  };
  const linked = trees.filter((t) => t.path !== root && (t.branch || t.detached));
  const subprocess = async (cmd: string[], cwd?: string) => {
    const child = Bun.spawn(cmd, {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exited;
  };
  const runExec = async (wt: string) => {
    const cmd = exec || (await config("exec"));
    if (!noExec && cmd && (await subprocess(["sh", "-c", cmd], wt)))
      console.error(`Warning: exec command failed: ${cmd}`);
  };
  const setupScript = async (wt: string, strict: boolean) => {
    const location = await config("setupLocation");
    if (!location) {
      if (strict) throw new Error("Setup location not configured. Run 'sp ht setup --init'");
      return false;
    }
    const script = expand(location, wt);
    if (
      !(await stat(script).then(
        (info) => info.isFile(),
        () => false,
      ))
    ) {
      if (strict) throw new Error(`Setup script not found: ${script}`);
      return false;
    }
    if (!(await exists(script, true))) {
      if (strict) throw new Error(`Setup script is not executable: ${script}`);
      return false;
    }
    console.log(`Running setup for worktree: ${wt}\nUsing setup script: ${script}`);
    const code = await subprocess(["sh", "-c", '"$0" "$@"', script, root, wt]);
    if (code) {
      if (strict) throw new Error(`Setup script failed with exit code ${code}`);
      console.error("Warning: Setup script failed (worktree was still created)");
      return true;
    }
    console.log("Setup completed successfully");
    return false;
  };
  if (command === "list") {
    for (const t of linked)
      console.log(
        `${t.branch ?? "(detached)"}\t${t.path}${t.detached ? "\t! no branch (detached HEAD)" : t.path.endsWith(`/${t.branch}`) ? "" : "\t! path does not match branch (git checkout run inside?)"}`,
      );
    if (!linked.length) console.log("No linked worktrees found");
    return;
  }
  if (command === "setup") {
    if (init !== undefined) {
      if (await config("setupLocation"))
        throw new Error(
          "Setup location is already configured. Unset happy-trees.setupLocation first.",
        );
      const absolute = init.startsWith("/") || init.startsWith("~");
      const value = absolute ? init : `<repo_root>/${init}`;
      const script = absolute ? init.replace(/^~/, process.env.HOME ?? "") : resolve(root, init);
      if (await exists(script)) throw new Error(`File already exists at destination: ${script}`);
      await mkdir(dirname(script), { recursive: true });
      const shell = !basename(script).includes(".") || script.endsWith(".sh");
      await Bun.write(
        script,
        shell
          ? `#!/usr/bin/env bash\n# Happy Trees setup receives the main repository and target worktree paths.\nREPO_ROOT="$1"\nWORKTREE_ROOT="$2"\n\n# Put setup commands here; change directory explicitly when needed.\necho "Setup complete for worktree: $WORKTREE_ROOT"\n`
          : `# This file has a non-.sh extension. Add a shebang, translate this template,\n# and make it executable. Arguments: argv[1] = repo root; argv[2] = worktree root.\n`,
      );
      if (shell) await chmod(script, 0o755);
      await run(["config", "happy-trees.setupLocation", value]);
      console.log(
        `Setup script created: ${script}\nGit config set: happy-trees.setupLocation = ${value}\n\nNext steps:\nEdit ${script}, then run 'sp ht setup' from inside a worktree.`,
      );
    } else {
      if (!(await config("setupLocation")))
        throw new Error("Setup location not configured. Run 'sp ht setup --init'");
      if (admin === common)
        throw new Error("Not in a linked worktree. Run this command from inside a worktree.");
      await setupScript(await run(["rev-parse", "--show-toplevel"]), true);
    }
    return;
  }
  let entries = linked
    .filter((t) => t.branch)
    .map((t) => `${t.branch}\t(${command === "checkout" ? "worktree" : `worktree: ${t.path}`})`);
  if (command === "checkout") {
    const seen = new Set(linked.map((t) => t.branch));
    for (const ref of (
      await run([
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)",
        "refs/heads/",
        "refs/remotes/origin/",
      ])
    ).split("\n")) {
      const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, "");
      if (!name || name === "HEAD" || seen.has(name)) continue;
      seen.add(name);
      entries.push(
        `${name}\t(${ref.startsWith("refs/heads/") ? "local" : `remote: origin/${name}`})`,
      );
    }
  } else if (command === "destroy") {
    const name = (await defaultBranch()).replace(/^origin\//, "");
    entries = entries.filter((e) => e.split("\t")[0] !== name);
  }
  if (
    (command === "checkout" && process.env.GIT_HT_DUMP === "checkout-entries") ||
    (command === "remove" && process.env.GIT_HT_DUMP === "worktree-entries")
  ) {
    if (entries.length) console.log(entries.join("\n"));
    return;
  }
  let branch = positional[0];
  if (!branch) {
    if (!Bun.which("fzf"))
      throw new Error(
        "fzf is required for interactive selection. Install fzf or provide the branch name as an argument",
      );
    if (!entries.length)
      throw new Error(command === "checkout" ? "No branches found" : "No worktrees found");
    const child = Bun.spawn(
      [
        "fzf",
        "--ansi",
        `--prompt=Select ${command === "checkout" ? "branch" : "worktree"}: `,
        `--header=${command === "checkout" ? "Branches (worktrees listed first)" : "Worktrees"}`,
      ],
      { stdin: Buffer.from(entries.join("\n")), stdout: "pipe", stderr: "inherit" },
    );
    const selected = await new Response(child.stdout).text();
    if ((await child.exited) || !selected.trim()) throw new Error("Selection cancelled");
    branch = selected.trim().split(/\s/)[0] ?? "";
  }
  const tree = trees.find((t) => t.branch === branch);
  if (command === "checkout") {
    if (
      admin === common &&
      root !== common &&
      (basename(common) !== ".git" || root !== dirname(common))
    ) {
      await Bun.write(rootCache, JSON.stringify(root));
    }
    const base = positional[1];
    if (tree) {
      if (base)
        throw new Error(
          `[base] argument is not valid when worktree already exists for '${branch}'`,
        );
      console.log(`Worktree already exists: ${tree.path}`);
      await runExec(tree.path);
      console.log(`\nNext steps:\n  cd ${tree.path}`);
      return;
    }
    const parent = resolve(
      root,
      expand(await config("worktreesDir", "<repo_root>/../<repo_name>.worktrees")),
    );
    const path = resolve(parent, branch);
    if (await exists(path))
      throw new Error(
        `Directory already exists but is not a registered worktree: ${path}\nRemove it manually if it is stale.`,
      );
    await mkdir(parent, { recursive: true });
    if ((await hasLocal(branch)) || (await remoteSha(branch))) {
      if (base)
        throw new Error(`[base] argument is not valid when branch '${branch}' already exists`);
      await run(["worktree", "add", path, branch]);
    } else await run(["worktree", "add", "-b", branch, path, base ?? (await defaultBranch())]);
    console.log(`Created worktree at: ${path}`);
    const suggest = skip || (await setupScript(path, false));
    await runExec(path);
    console.log(`\nNext steps:\n  cd ${path}${suggest ? " && sp ht setup" : ""}`);
    return;
  }
  if (command === "destroy" && branch === (await defaultBranch()).replace(/^origin\//, ""))
    throw new Error(`Cannot destroy the default branch '${branch}'`);
  if (!tree) throw new Error(`No worktree found for branch '${branch}'`);
  if (command === "destroy" && !force) {
    const reasons: string[] = [];
    if (
      (await config("failDestroyOnPathMismatch", "true")) !== "false" &&
      !tree.path.endsWith(`/${branch}`)
    )
      reasons.push(
        `The worktree's path usually indicates the branch it contains, but this one does not.\nPath: ${tree.path}\nBranch: ${branch}\nDisable with: git config happy-trees.failDestroyOnPathMismatch false`,
      );
    if (await run(["status", "--porcelain"], tree.path))
      reasons.push(`Worktree '${branch}' has uncommitted changes.`);
    if (reasons.length)
      throw new Error(
        `${reasons.join("\n")}\nPass the --force flag to continue (this overrides all of the above).`,
      );
  }
  // Repository operations remain usable after removing the caller's worktree.
  await run(["worktree", "remove", ...(force ? ["--force"] : []), tree.path], root);
  repositoryCwd = root;
  console.log(`Removed worktree: ${tree.path}`);
  const remote = await remoteSha(branch);
  if (await hasLocal(branch)) {
    const local = await run(["rev-parse", `refs/heads/${branch}`], root);
    if (command === "destroy" || (remote && local === remote)) {
      await run(["branch", "-D", branch], root);
      console.log(
        command === "destroy"
          ? `Deleted local branch: ${branch}`
          : `Deleted local branch '${branch}' (fully represented on remote)`,
      );
    } else
      console.log(
        `Kept local branch '${branch}' (${remote ? "differs from remote" : "no remote branch exists"})\n\nTo delete the local branch:\n  git branch -D ${branch}${remote ? `\n\nTo also delete the remote branch:\n  git push origin --delete ${branch}` : ""}`,
      );
  }
  if (command === "destroy" && remote) {
    await run(["push", "origin", "--delete", branch], root);
    console.log(`Deleted remote branch: ${branch}`);
  }
}
