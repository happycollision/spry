export const SHA_POOL: readonly string[] = [];
export const SPRY_ID_POOL: readonly string[] = [];

export function buildShaMap(_shas: string[]): Map<string, string> {
  throw new Error("not implemented");
}

export function buildSpryMap(_spryIds: string[]): Map<string, string> {
  throw new Error("not implemented");
}

export function scanAndReplace(
  _content: string,
  _shaMap: Map<string, string>,
  _spryMap: Map<string, string>,
): string {
  throw new Error("not implemented");
}
