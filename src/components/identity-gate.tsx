"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { useEvelandIdentity } from "@/components/identity-provider";
import { EvelandIdentityError } from "@/identity/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type GateState =
  | { phase: "checking" }
  | { phase: "redirecting" }
  | { phase: "unavailable"; message: string }
  /** Open-access Eveland: no identity exists; the app runs on its anonymous browser session. */
  | { phase: "open" }
  | { phase: "authenticated" };

export function IdentityGate({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const { getSession, getAppToken, getLoginAvailability, login } =
    useEvelandIdentity();
  const [state, setState] = useState<GateState>({ phase: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await getSession();
        if (!active) return;
        if (!session.authenticated) {
          const availability = await getLoginAvailability(pathname);
          if (!active) return;
          if (!availability.available) {
            if (availability.code === "identity_login_not_required") {
              // The instance is open to all callers; there is no identity to
              // establish, so the gate stands aside and anonymous
              // browser-session ownership carries the app, as before the gate.
              setState({ phase: "open" });
              return;
            }
            // Login exists in principle but this instance refuses it (target
            // not registered, provider not configured). Redirecting would
            // strand the browser on the refusal JSON — surface it instead.
            setState({ phase: "unavailable", message: availability.message });
            return;
          }
          setState({ phase: "redirecting" });
          login(pathname);
          return;
        }
        setState({ phase: "authenticated" });
        // Chats this browser created before signing in stay reachable only
        // through the local session cookie; adopt them into the identity so
        // they follow the user to other devices. Best effort — the next full
        // load retries.
        try {
          const token = await getAppToken(pathname);
          await fetch("/api/chats/claim", {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          });
        } catch {
          // Ignored: claiming is idempotent and retried on the next load.
        }
      } catch (error) {
        if (!active) return;
        if (
          error instanceof EvelandIdentityError &&
          error.code === "identity_redirecting"
        ) {
          setState({ phase: "redirecting" });
          return;
        }
        setState({
          phase: "unavailable",
          message:
            error instanceof EvelandIdentityError
              ? error.message
              : "Eveland Identity is unavailable.",
        });
      }
    })();
    return () => {
      active = false;
    };
    // The gate re-runs only on explicit retry; pathname changes after the
    // first successful check must not re-enter the login redirect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, getAppToken, getLoginAvailability, getSession, login]);

  if (state.phase === "authenticated" || state.phase === "open") {
    return <>{children}</>;
  }

  return (
    <div className="flex h-svh w-full flex-col items-center justify-center gap-4 p-6">
      {state.phase === "unavailable" ? (
        <>
          <p className="text-sm text-muted-foreground">{state.message}</p>
          <Button
            variant="outline"
            onClick={() => {
              setState({ phase: "checking" });
              setAttempt((current) => current + 1);
            }}
          >
            Retry
          </Button>
        </>
      ) : (
        <>
          <Spinner className="size-5" />
          <p className="text-sm text-muted-foreground">
            {state.phase === "redirecting"
              ? "Redirecting to Eveland sign-in…"
              : "Checking your Eveland session…"}
          </p>
        </>
      )}
    </div>
  );
}
