import { AuthMethodCatalog } from "@/agent-auth/catalog";
import type {
  AuthMethodFormDescriptor,
  AuthMethodRegistration,
} from "@/agent-auth/contracts";
import {
  basicAuthMethodDescriptor,
  bearerAuthMethodDescriptor,
  headersAuthMethodDescriptor,
  noneAuthMethodDescriptor,
} from "@/agent-auth/form-descriptors";
import {
  basicAuthMethodRegistration,
  bearerAuthMethodRegistration,
  headersAuthMethodRegistration,
  noneAuthMethodRegistration,
} from "@/agent-auth/static-methods";

export const builtInAuthMethodCatalog = new AuthMethodCatalog([
  {
    key: "none",
    registration: noneAuthMethodRegistration,
    descriptor: noneAuthMethodDescriptor,
  },
  {
    key: "basic",
    registration: basicAuthMethodRegistration,
    descriptor: basicAuthMethodDescriptor,
  },
  {
    key: "bearer",
    registration: bearerAuthMethodRegistration,
    descriptor: bearerAuthMethodDescriptor,
  },
  {
    key: "headers",
    registration: headersAuthMethodRegistration,
    descriptor: headersAuthMethodDescriptor,
  },
]);

export const authMethodCatalog = builtInAuthMethodCatalog;

export function getAuthMethodRegistration(method: string): AuthMethodRegistration {
  return builtInAuthMethodCatalog.getRegistration(method);
}

export function listAuthMethodRegistrations(): readonly AuthMethodRegistration[] {
  return builtInAuthMethodCatalog.listRegistrations();
}

export function getAuthMethodFormDescriptor(method: string): AuthMethodFormDescriptor {
  return builtInAuthMethodCatalog.getDescriptor(method);
}

export function listAuthMethodFormDescriptors(): readonly AuthMethodFormDescriptor[] {
  return builtInAuthMethodCatalog.listDescriptors();
}
