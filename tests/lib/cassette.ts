import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandResult, CommandOptions } from "./context.ts";

export interface CassetteEntry {
  args: string[];
  options?: CommandOptions;
  result: CommandResult;
}

export interface Cassette {
  entries: CassetteEntry[];
}

export async function writeCassette(
  path: string,
  cassette: Cassette,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(cassette, null, 2) + "\n");
}

export async function readCassette(path: string): Promise<Cassette> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Cassette file not found: ${path}`);
  }
  return (await file.json()) as Cassette;
}
