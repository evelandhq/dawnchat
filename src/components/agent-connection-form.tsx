"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/native-select";

type AuthType = "none" | "bearer" | "header";

type FormErrors = Partial<Record<"name" | "baseUrl" | "bearerToken" | "headerName" | "headerValue" | "submit", string>>;

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isValidHttpHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

function FieldError({ message }: { message: string | undefined }): React.ReactElement | null {
  if (!message) {
    return null;
  }
  return (
    <p role="alert" className="text-destructive text-sm">
      {message}
    </p>
  );
}

export function AgentConnectionForm(): React.ReactElement {
  const router = useRouter();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [bearerToken, setBearerToken] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  function validate(): FormErrors {
    const nextErrors: FormErrors = {};

    if (!name.trim()) {
      nextErrors.name = "Name is required.";
    }

    if (!isValidHttpUrl(baseUrl.trim())) {
      nextErrors.baseUrl = "Base URL must be a valid http(s) URL.";
    }

    if (authType === "bearer" && !bearerToken.trim()) {
      nextErrors.bearerToken = "Bearer token is required.";
    }

    if (authType === "header") {
      if (!headerName.trim()) {
        nextErrors.headerName = "Header name is required.";
      } else if (!isValidHttpHeaderName(headerName.trim())) {
        nextErrors.headerName = "Header name must be a valid HTTP header name.";
      }
      if (!headerValue.trim()) {
        nextErrors.headerValue = "Header value is required.";
      }
    }

    return nextErrors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    const payload: Record<string, string> = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      authType,
    };

    if (authType === "bearer") {
      payload.bearerToken = bearerToken;
    }

    if (authType === "header") {
      payload.headerName = headerName.trim();
      payload.headerValue = headerValue;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        setErrors({ submit: "Unable to register agent. Please check the connection and try again." });
        return;
      }

      const body = (await response.json()) as { agent?: { id?: unknown } };
      if (typeof body.agent?.id !== "string") {
        setErrors({ submit: "Unable to register agent. Please check the connection and try again." });
        return;
      }

      router.push(`/agents/${body.agent.id}`);
      router.refresh();
    } catch {
      setErrors({ submit: "Unable to register agent. Please check the connection and try again." });
    } finally {
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
        <Label htmlFor="agent-auth-type">Auth Type</Label>
        <NativeSelect
          id="agent-auth-type"
          name="authType"
          value={authType}
          onChange={(event) => setAuthType(event.target.value as AuthType)}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer Token</option>
          <option value="header">Custom Header</option>
        </NativeSelect>
      </div>

      {authType === "bearer" ? (
        <div className="grid gap-2">
          <Label htmlFor="agent-bearer-token">Bearer Token</Label>
          <Input
            id="agent-bearer-token"
            name="bearerToken"
            type="password"
            value={bearerToken}
            onChange={(event) => setBearerToken(event.target.value)}
          />
          <FieldError message={errors.bearerToken} />
        </div>
      ) : null}

      {authType === "header" ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="agent-header-name">Header Name</Label>
            <Input
              id="agent-header-name"
              name="headerName"
              value={headerName}
              onChange={(event) => setHeaderName(event.target.value)}
            />
            <FieldError message={errors.headerName} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-header-value">Header Value</Label>
            <Input
              id="agent-header-value"
              name="headerValue"
              type="password"
              value={headerValue}
              onChange={(event) => setHeaderValue(event.target.value)}
            />
            <FieldError message={errors.headerValue} />
          </div>
        </>
      ) : null}

      <FieldError message={errors.submit} />

      <Button type="submit" disabled={isSubmitting} className="justify-self-start">
        {isSubmitting ? "Registering…" : "Register agent"}
      </Button>
    </form>
  );
}
