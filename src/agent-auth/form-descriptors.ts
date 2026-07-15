import type {
  AuthMethodFormDescriptor,
  FieldDescriptor,
} from "@/agent-auth/contracts";

export const noneAuthMethodDescriptor = createDescriptor({
  method: "none",
  label: "No authentication",
  interactive: false,
  fields: [],
});

export const basicAuthMethodDescriptor = createDescriptor({
  method: "basic",
  label: "HTTP Basic",
  interactive: false,
  fields: [
    {
      name: "username",
      label: "Username",
      type: "text",
      required: true,
      autocomplete: "username",
    },
    {
      name: "password",
      label: "Password",
      type: "secret",
      required: true,
      autocomplete: "current-password",
    },
  ],
});

export const bearerAuthMethodDescriptor = createDescriptor({
  method: "bearer",
  label: "Bearer token",
  interactive: false,
  fields: [
    {
      name: "token",
      label: "Token",
      type: "secret",
      required: true,
      autocomplete: "off",
    },
  ],
});

export const headersAuthMethodDescriptor = createDescriptor({
  method: "headers",
  label: "Custom headers",
  interactive: false,
  fields: [
    {
      name: "headers",
      label: "Headers",
      type: "key-value",
      required: true,
      keyLabel: "Header name",
      valueLabel: "Header value",
    },
  ],
});

function createDescriptor(input: {
  readonly method: string;
  readonly label: string;
  readonly interactive: boolean;
  readonly fields: readonly FieldDescriptor[];
}): AuthMethodFormDescriptor {
  const fields = Object.freeze(input.fields.map((field) => Object.freeze({ ...field })));
  return Object.freeze({ ...input, fields });
}
