import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function projectStorageKey(cwd: string): string {
  const absoluteCwd = resolve(cwd);
  return `v2-${createHash("sha256").update(absoluteCwd).digest("hex").slice(0, 32)}`;
}
