import { randomBytes } from "crypto";

export function generateCommitId(): string {
  return randomBytes(4).toString("hex");
}
