import type { SpryConfig } from "./config.ts";
import type { PRUnit } from "../parse/types.ts";
import { validateBranchName } from "../parse/validation.ts";

export function branchForUnit(unit: PRUnit, config: SpryConfig): string {
  const name = `${config.branchPrefix}/${unit.id}`;
  const validation = validateBranchName(name);
  if (!validation.ok) {
    throw new Error(`Invalid derived branch name '${name}': ${validation.error}`);
  }
  return name;
}
