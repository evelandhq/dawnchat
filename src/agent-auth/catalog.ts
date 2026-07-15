import type {
  AuthMethodCatalogEntry,
  AuthMethodFormDescriptor,
  AuthMethodRegistration,
  FieldDescriptor,
} from "@/agent-auth/contracts";

export class UnknownAuthMethodError extends Error {
  constructor(method: string) {
    super(`Unknown auth method: ${method}`);
    this.name = "UnknownAuthMethodError";
  }
}

export class AuthMethodCatalog {
  readonly #registrations: ReadonlyMap<string, AuthMethodRegistration>;
  readonly #descriptors: ReadonlyMap<string, AuthMethodFormDescriptor>;
  readonly #registrationList: readonly AuthMethodRegistration[];
  readonly #descriptorList: readonly AuthMethodFormDescriptor[];

  constructor(entries: readonly AuthMethodCatalogEntry[]) {
    const registrations = new Map<string, AuthMethodRegistration>();
    const descriptors = new Map<string, AuthMethodFormDescriptor>();

    for (const entry of entries) {
      validateEntry(entry, registrations);

      const registration = freezeRegistration(entry.registration);
      const descriptor = freezeDescriptor(entry.descriptor);
      registrations.set(entry.key, registration);
      descriptors.set(entry.key, descriptor);
    }

    this.#registrations = registrations;
    this.#descriptors = descriptors;
    this.#registrationList = Object.freeze([...registrations.values()]);
    this.#descriptorList = Object.freeze([...descriptors.values()]);
    Object.freeze(this);
  }

  getRegistration(method: string): AuthMethodRegistration {
    const registration = this.#registrations.get(method);
    if (registration === undefined) {
      throw new UnknownAuthMethodError(method);
    }
    return registration;
  }

  listRegistrations(): readonly AuthMethodRegistration[] {
    return this.#registrationList;
  }

  getDescriptor(method: string): AuthMethodFormDescriptor {
    const descriptor = this.#descriptors.get(method);
    if (descriptor === undefined) {
      throw new UnknownAuthMethodError(method);
    }
    return descriptor;
  }

  listDescriptors(): readonly AuthMethodFormDescriptor[] {
    return this.#descriptorList;
  }
}

function validateEntry(
  entry: AuthMethodCatalogEntry,
  registrations: ReadonlyMap<string, AuthMethodRegistration>,
): void {
  const { key, registration, descriptor } = entry;
  if (key.length === 0 || registration.method.length === 0) {
    throw new Error("Auth method identifiers must not be empty");
  }
  if (registrations.has(key)) {
    throw new Error(`Duplicate auth method: ${key}`);
  }
  if (
    key !== registration.method ||
    key !== registration.provider.method ||
    key !== descriptor.method
  ) {
    throw new Error(
      `Auth method registration key, method, provider.method, and descriptor.method must match: ${key}`,
    );
  }

  if (descriptor.interactive) {
    if (registration.interaction === undefined) {
      throw new Error(`Interactive auth method ${key} requires an interaction authorizePath`);
    }
    assertSafeAuthorizePath(registration.interaction.authorizePath);
  } else if (registration.interaction !== undefined) {
    throw new Error(`Noninteractive auth method ${key} must not declare interaction`);
  }
}

function assertSafeAuthorizePath(authorizePath: string): void {
  let decoded = authorizePath;

  for (let depth = 0; depth < 8; depth += 1) {
    if (!isSafeRootRelativePath(decoded)) {
      throw new Error(`Invalid authorizePath: ${authorizePath}`);
    }

    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error(`Invalid authorizePath: ${authorizePath}`);
    }
    if (next === decoded) {
      return;
    }
    decoded = next;
  }

  throw new Error(`Invalid authorizePath: ${authorizePath}`);
}

function isSafeRootRelativePath(path: string): boolean {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /%2f/i.test(path) ||
    path.includes("?") ||
    path.includes("#") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(path)
  ) {
    return false;
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return false;
  }

  const parsed = new URL(path, "https://auth-method-catalog.invalid");
  return (
    parsed.origin === "https://auth-method-catalog.invalid" &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  );
}

function freezeRegistration(
  registration: AuthMethodRegistration,
): AuthMethodRegistration {
  const interaction =
    registration.interaction === undefined
      ? undefined
      : Object.freeze({ ...registration.interaction });

  return Object.freeze({ ...registration, ...(interaction === undefined ? {} : { interaction }) });
}

function freezeDescriptor(descriptor: AuthMethodFormDescriptor): AuthMethodFormDescriptor {
  const fields = Object.freeze(descriptor.fields.map((field) => freezeField(field)));
  return Object.freeze({ ...descriptor, fields });
}

function freezeField(field: FieldDescriptor): FieldDescriptor {
  return Object.freeze({ ...field });
}
