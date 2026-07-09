import Link from "next/link";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <div style={{ minHeight: "100vh", fontFamily: "system-ui, sans-serif", color: "#111827" }}>
      <header style={{ borderBottom: "1px solid #e5e7eb", padding: "1rem 1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", maxWidth: "64rem", margin: "0 auto" }}>
          <Link href="/" style={{ fontWeight: 700, textDecoration: "none", color: "inherit" }}>
            Eve Chats
          </Link>
          <nav aria-label="Main navigation" style={{ display: "flex", gap: "0.75rem" }}>
            <Link href="/agents">Agents</Link>
            <a href="/chats">Chats</a>
          </nav>
        </div>
      </header>
      <main style={{ maxWidth: "64rem", margin: "0 auto", padding: "2rem 1.5rem" }}>{children}</main>
    </div>
  );
}
