"use client";

import { type FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgentConnectionStatus } from "@/db/schema";
import {
  agentAuthMethodDescriptors,
  getAgentAuthMethodDescriptor,
  type AgentAuthMethod,
  type AgentAuthMethodFieldDescriptor,
} from "@/eve/auth-methods";
import { agentAuthValuesFromConfig, serializeAgentAuthConfig } from "@/lib/agent-auth-form";

export type AgentConnectionFormInitialAgent = {
  id: string;
  name: string;
  baseUrl: string;
  authType: AgentAuthMethod;
  hasAuth: boolean;
  securityRevision: number;
  config: Record<string, unknown>;
  status: AgentConnectionStatus;
};

type AgentConnectionFormProps = {
  initialAgent?: AgentConnectionFormInitialAgent;
};

type FormErrors = Record<string, string | undefined>;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "[::1]"
      || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

function FieldError({ message }: { message: string | undefined }): React.ReactElement | null {
  if (!message) return null;
  return <p role="alert" className="text-destructive text-sm">{message}</p>;
}

export function AgentConnectionForm({ initialAgent }: AgentConnectionFormProps): React.ReactElement {
  const router = useRouter();
  const isEditing = initialAgent !== undefined;
  const initialDescriptor = getAgentAuthMethodDescriptor(initialAgent?.authType ?? "none");
  const [name, setName] = useState(initialAgent?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initialAgent?.baseUrl ?? "");
  const [authType, setAuthType] = useState<AgentAuthMethod>(initialAgent?.authType ?? "none");
  const [values, setValues] = useState<Record<string, string>>(
    initialAgent ? agentAuthValuesFromConfig(initialDescriptor, initialAgent.config) : {},
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const descriptor = getAgentAuthMethodDescriptor(authType);

  function canPreserveSecret(field: AgentAuthMethodFieldDescriptor): boolean {
    if (!initialAgent || initialAgent.authType !== authType || !field.secret) return false;
    if (field.key === "headers") return Array.isArray(initialAgent.config.headerNames)
      && initialAgent.config.headerNames.length > 0;
    return initialAgent.config[`${field.key}Configured`] === true;
  }

  function validate(): { errors: FormErrors; config?: Record<string, unknown> } {
    const nextErrors: FormErrors = {};
    if (!name.trim()) nextErrors.name = "Name is required.";
    if (!isValidHttpUrl(baseUrl.trim())) {
      nextErrors.baseUrl = "Base URL must be a valid http(s) URL.";
    } else if (authType === "local-dev" && !isLoopbackUrl(baseUrl.trim())) {
      nextErrors.baseUrl = "Local development requires a loopback Agent URL.";
    }

    for (const field of descriptor.fields) {
      const value = values[field.key] ?? field.defaultValue ?? "";
      if (field.required && !value.trim() && !canPreserveSecret(field)) {
        nextErrors[field.key] = `${field.label} is required.`;
      }
    }
    if (authType === "oidc") {
      const tokenMethod = values.tokenEndpointAuthMethod ?? "none";
      const canPreserveClientSecret = initialAgent?.authType === "oidc"
        && initialAgent.config.clientSecretConfigured === true;
      if (tokenMethod !== "none" && !values.clientSecret?.trim() && !canPreserveClientSecret) {
        nextErrors.clientSecret = `OIDC ${tokenMethod} authentication requires a client secret.`;
      }
      if ((values.accessTokenVerification ?? "userinfo") === "eve-jwt" && !values.audience?.trim()) {
        nextErrors.audience = "OIDC Eve JWT verification requires an audience.";
      }
    }

    let config: Record<string, unknown> | undefined;
    if (Object.keys(nextErrors).length === 0) {
      try {
        config = serializeAgentAuthConfig(descriptor, values);
      } catch (error) {
        nextErrors.config = error instanceof Error ? error.message : "Invalid Agent access configuration.";
      }
    }
    return { errors: nextErrors, config };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    const validation = validate();
    setErrors(validation.errors);
    if (!validation.config || Object.keys(validation.errors).length > 0) return;

    isSubmittingRef.current = true;
    const endpoint = isEditing ? `/api/agents/${initialAgent.id}` : "/api/agents";
    const method = isEditing ? "PATCH" : "POST";
    const genericSubmitError = isEditing
      ? "Unable to update agent. Please check the connection and try again."
      : "Unable to register agent. Please check the connection and try again.";

    setIsSubmitting(true);
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          authType,
          config: validation.config,
        }),
      });
      if (response.status === 409) {
        setErrors({ submit: "An agent with this URL is already registered." });
        return;
      }
      if (!response.ok) {
        setErrors({ submit: genericSubmitError });
        return;
      }
      const body = (await response.json()) as {
        agent?: { id?: unknown; status?: unknown };
      };
      if (typeof body.agent?.id !== "string") {
        setErrors({ submit: genericSubmitError });
        return;
      }
      if (body.agent.status === "authorization_required") {
        router.push(`/agents/${body.agent.id}/edit`);
      } else if (isEditing) {
        router.push("/agents");
      } else {
        router.push(`/agents/${body.agent.id}`);
      }
      router.refresh();
    } catch {
      setErrors({ submit: genericSubmitError });
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-5" noValidate>
      <div className="grid gap-2">
        <Label htmlFor="agent-name">Name</Label>
        <Input id="agent-name" name="name" value={name} onChange={(event) => setName(event.target.value)} />
        <FieldError message={errors.name} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="agent-base-url">Base URL</Label>
        <Input
          id="agent-base-url"
          name="baseUrl"
          placeholder="https://eve.example.com"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <FieldError message={errors.baseUrl} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="agent-auth-type">Agent access method</Label>
        <NativeSelect
          id="agent-auth-type"
          name="authType"
          value={authType}
          onChange={(event) => {
            const nextMethod = event.target.value as AgentAuthMethod;
            setAuthType(nextMethod);
            setValues(agentAuthValuesFromConfig(getAgentAuthMethodDescriptor(nextMethod), {}));
            setErrors({});
          }}
        >
          {agentAuthMethodDescriptors.map((candidate) => (
            <option key={candidate.method} value={candidate.method}>{candidate.label}</option>
          ))}
        </NativeSelect>
        <p className="text-muted-foreground text-sm">{descriptor.description}</p>
      </div>

      {descriptor.fields.map((field) => {
        const id = `agent-auth-${authType}-${field.key}`;
        const value = values[field.key] ?? field.defaultValue ?? "";
        return (
          <div className="grid gap-2" key={field.key}>
            <Label htmlFor={id}>{field.label}</Label>
            {field.input === "textarea" ? (
              <Textarea
                id={id}
                name={field.key}
                rows={4}
                value={value}
                onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
              />
            ) : field.input === "select" ? (
              <NativeSelect
                id={id}
                name={field.key}
                value={value}
                onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
              >
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </NativeSelect>
            ) : (
              <Input
                id={id}
                name={field.key}
                type={field.input === "password" ? "password" : "text"}
                autoComplete={field.secret ? "new-password" : "off"}
                value={value}
                onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
              />
            )}
            {field.secret && canPreserveSecret(field) ? (
              <p className="text-muted-foreground text-sm">Leave blank to keep the configured value.</p>
            ) : null}
            <FieldError message={errors[field.key]} />
          </div>
        );
      })}

      <FieldError message={errors.config} />
      <FieldError message={errors.submit} />
      <Button type="submit" disabled={isSubmitting} className="justify-self-start">
        {isSubmitting
          ? isEditing ? "Saving…" : "Registering…"
          : isEditing ? "Save changes" : "Register agent"}
      </Button>
    </form>
  );
}
