/**
 * Minimum accepted length after trimming, measured in UTF-8 bytes.
 * This is a fail-closed length/placeholder check; it does not estimate entropy.
 */
export const MIN_AUTH_SECRET_BYTES = 32;

export class InvalidAuthSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuthSecretError";
  }
}

export function readValidatedAuthSecret(errorMessage: string): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (
    !secret ||
    secret === "replace-with-local-dev-secret" ||
    secret === "replace-with-a-local-secret" ||
    Buffer.byteLength(secret, "utf8") < MIN_AUTH_SECRET_BYTES
  ) {
    throw new InvalidAuthSecretError(errorMessage);
  }

  return secret;
}
