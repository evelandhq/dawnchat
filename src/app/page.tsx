import Link from "next/link";

export default function HomePage(): React.ReactElement {
  return (
    <section style={{ display: "grid", gap: "1rem" }}>
      <h1>Eve Chats</h1>
      <p>Connect an Eve agent, then use it in chat.</p>
      <div style={{ display: "flex", gap: "1rem" }}>
        <Link href="/agents">Manage agents</Link>
        <a href="/chats">Chats</a>
      </div>
    </section>
  );
}
