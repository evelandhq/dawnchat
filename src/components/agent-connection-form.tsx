"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

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

      router.push("/agents");
    } catch {
      setErrors({ submit: "Unable to register agent. Please check the connection and try again." });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: "1rem", maxWidth: "36rem" }} noValidate>
      <div style={{ display: "grid", gap: "0.35rem" }}>
        <label htmlFor="agent-name">Name</label>
        <input id="agent-name" name="name" value={name} onChange={(event) => setName(event.target.value)} />
        {errors.name ? <p role="alert">{errors.name}</p> : null}
      </div>

      <div style={{ display: "grid", gap: "0.35rem" }}>
        <label htmlFor="agent-base-url">Base URL</label>
        <input
          id="agent-base-url"
          name="baseUrl"
          placeholder="https://eve.example.com"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        {errors.baseUrl ? <p role="alert">{errors.baseUrl}</p> : null}
      </div>

      <div style={{ display: "grid", gap: "0.35rem" }}>
        <label htmlFor="agent-auth-type">Auth Type</label>
        <select
          id="agent-auth-type"
          name="authType"
          value={authType}
          onChange={(event) => setAuthType(event.target.value as AuthType)}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer Token</option>
          <option value="header">Custom Header</option>
        </select>
      </div>

      {authType === "bearer" ? (
        <div style={{ display: "grid", gap: "0.35rem" }}>
          <label htmlFor="agent-bearer-token">Bearer Token</label>
          <input
            id="agent-bearer-token"
            name="bearerToken"
            type="password"
            value={bearerToken}
            onChange={(event) => setBearerToken(event.target.value)}
          />
          {errors.bearerToken ? <p role="alert">{errors.bearerToken}</p> : null}
        </div>
      ) : null}

      {authType === "header" ? (
        <>
          <div style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor="agent-header-name">Header Name</label>
            <input
              id="agent-header-name"
              name="headerName"
              value={headerName}
              onChange={(event) => setHeaderName(event.target.value)}
            />
            {errors.headerName ? <p role="alert">{errors.headerName}</p> : null}
          </div>
          <div style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor="agent-header-value">Header Value</label>
            <input
              id="agent-header-value"
              name="headerValue"
              type="password"
              value={headerValue}
              onChange={(event) => setHeaderValue(event.target.value)}
            />
            {errors.headerValue ? <p role="alert">{errors.headerValue}</p> : null}
          </div>
        </>
      ) : null}

      {errors.submit ? <p role="alert">{errors.submit}</p> : null}

      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Registering…" : "Register agent"}
      </button>
    </form>
  );
}
