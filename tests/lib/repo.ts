import { $ } from "bun";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { generateUniqueId } from "./unique-id.ts";

export interface TestRepo {
  path: string;
  originPath: string;
  uniqueId: string;
  defaultBranch: string;

  commit(message?: string): Promise<string>;
  commitFiles(files: Record<string, string>, message?: string): Promise<string>;
  branch(name: string): Promise<string>;
  checkout(name: string): Promise<void>;
  fetch(): Promise<void>;
  currentBranch(): Promise<string>;
  cleanup(): Promise<void>;
}

export interface CreateRepoOptions {
  defaultBranch?: string;
}

let counter = 0;

export async function createRepo(options?: CreateRepoOptions): Promise<TestRepo> {
  const uniqueId = generateUniqueId();
  const defaultBranch = options?.defaultBranch ?? "main";
  const originPath = `/tmp/spry-test-origin-${uniqueId}`;
  const workPath = `/tmp/spry-test-${uniqueId}`;

  // Create bare origin
  await $`git init --bare ${originPath} --initial-branch=${defaultBranch}`.quiet();

  // Create working clone
  await $`git clone ${originPath} ${workPath}`.quiet();
  await $`git -C ${workPath} config user.email "test@example.com"`.quiet();
  await $`git -C ${workPath} config user.name "Test User"`.quiet();

  // Initial commit
  const initFile = join(workPath, "README.md");
  await Bun.write(initFile, "# Test repo\n");
  await $`git -C ${workPath} add .`.quiet();
  await $`git -C ${workPath} commit -m "Initial commit"`.quiet();
  await $`git -C ${workPath} push origin ${defaultBranch}`.quiet();

  async function commit(message?: string): Promise<string> {
    counter++;
    const filename = `file-${uniqueId}-${counter}.txt`;
    const msg = message ?? `Commit ${counter}`;
    await Bun.write(join(workPath, filename), `Content: ${msg}\n`);
    await $`git -C ${workPath} add .`.quiet();
    await $`git -C ${workPath} commit -m ${`${msg} [${uniqueId}]`}`.quiet();
    return (await $`git -C ${workPath} rev-parse HEAD`.quiet().text()).trim();
  }

  async function commitFiles(files: Record<string, string>, message?: string): Promise<string> {
    counter++;
    const msg = message ?? `Commit ${counter}`;
    for (const [name, content] of Object.entries(files)) {
      const filePath = join(workPath, name);
      const dir = join(filePath, "..");
      await mkdir(dir, { recursive: true });
      await Bun.write(filePath, content);
    }
    await $`git -C ${workPath} add .`.quiet();
    await $`git -C ${workPath} commit -m ${`${msg} [${uniqueId}]`}`.quiet();
    return (await $`git -C ${workPath} rev-parse HEAD`.quiet().text()).trim();
  }

  async function branch(name: string): Promise<string> {
    const branchName = `${name}-${uniqueId}`;
    await $`git -C ${workPath} checkout -b ${branchName}`.quiet();
    return branchName;
  }

  async function checkout(name: string): Promise<void> {
    await $`git -C ${workPath} checkout ${name}`.quiet();
  }

  async function fetch(): Promise<void> {
    await $`git -C ${workPath} fetch origin`.quiet();
  }

  async function currentBranch(): Promise<string> {
    return (await $`git -C ${workPath} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
  }

  async function cleanup(): Promise<void> {
    await rm(workPath, { recursive: true, force: true });
    await rm(originPath, { recursive: true, force: true });
  }

  return {
    path: workPath,
    originPath,
    uniqueId,
    defaultBranch,
    commit,
    commitFiles,
    branch,
    checkout,
    fetch,
    currentBranch,
    cleanup,
  };
}
