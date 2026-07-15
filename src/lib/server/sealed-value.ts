import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { readValidatedAuthSecret } from "@/lib/server/auth-secret";

const FORMAT_VERSION = "v1";
const KEY_VERSION = "k1";
const PREFIX = `sealed:${FORMAT_VERSION}:${KEY_VERSION}:`;
const KEY_DERIVATION_SALT = "eve-chats-sealed-value";

export interface SealedValueContext {
  readonly purpose: string;
  readonly identity: string;
}

export class InvalidSealedValueError extends Error {
  constructor() {
    super("Invalid sealed value");
    this.name = "InvalidSealedValueError";
  }
}

export function sealValue(plaintext: string, context: SealedValueContext): string {
  validateContext(context);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(context.purpose), iv);
  cipher.setAAD(createAdditionalAuthenticatedData(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function unsealValue(sealed: string, context: SealedValueContext): string {
  validateContext(context);
  const { iv, tag, ciphertext } = parseEnvelope(sealed);
  const key = deriveKey(context.purpose);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(createAdditionalAuthenticatedData(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new InvalidSealedValueError();
  }
}

function parseEnvelope(sealed: string): {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
} {
  try {
    if (!sealed.startsWith(PREFIX)) {
      throw new InvalidSealedValueError();
    }

    const parts = sealed.slice(PREFIX.length).split(".");
    if (parts.length !== 3 || parts[0].length === 0 || parts[1].length === 0) {
      throw new InvalidSealedValueError();
    }

    const [ivText, tagText, ciphertextText] = parts;
    const iv = decodeBase64UrlSegment(ivText);
    const tag = decodeBase64UrlSegment(tagText);
    const ciphertext = decodeBase64UrlSegment(ciphertextText, true);
    if (iv.length !== 12 || tag.length !== 16) {
      throw new InvalidSealedValueError();
    }

    return { iv, tag, ciphertext };
  } catch {
    throw new InvalidSealedValueError();
  }
}

function createAdditionalAuthenticatedData(context: SealedValueContext): Buffer {
  return Buffer.from(JSON.stringify([PREFIX, context.purpose, context.identity]), "utf8");
}

function decodeBase64UrlSegment(encoded: string, allowEmpty = false): Buffer {
  if (encoded.length === 0) {
    if (allowEmpty) {
      return Buffer.alloc(0);
    }
    throw new InvalidSealedValueError();
  }

  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new InvalidSealedValueError();
  }

  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    throw new InvalidSealedValueError();
  }

  return decoded;
}

function deriveKey(purpose: string): Buffer {
  const secret = readValidatedAuthSecret("AUTH_SECRET is required to seal values");

  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from(KEY_DERIVATION_SALT, "utf8"),
      Buffer.from(`${FORMAT_VERSION}\0${KEY_VERSION}\0${purpose}`, "utf8"),
      32,
    ),
  );
}

function validateContext(context: SealedValueContext): void {
  if (!context.purpose || !context.identity) {
    throw new Error("Sealed value purpose and identity are required");
  }
}
