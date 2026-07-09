import { randomUUID } from "node:crypto";

const idPrefixPattern = /^[a-z][a-z0-9_]*$/;

export function createId(prefix: string): string {
  const normalizedPrefix = prefix.trim();

  if (!idPrefixPattern.test(normalizedPrefix)) {
    throw new Error("ID prefix must start with a lowercase letter and contain only lowercase letters, numbers, or underscores");
  }

  return `${normalizedPrefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
