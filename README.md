# Dawn

Dawn is Eveland's standalone web chat for Eve Agents. It discovers chat-enabled
Agents from the Eveland Agent Catalog, supports manually registered external
Agents, and keeps identity- or browser-scoped conversation history in
PostgreSQL.

The UI renders Eve event streams, including text, reasoning, tool activity,
attachments, authentication challenges, and human-in-the-loop requests.

## Quick start

Requirements: Node.js 24 or newer, Corepack, and Docker with Compose support.

```sh
corepack pnpm install
cp .env.example .env.local
# Edit AUTH_SECRET and the Eveland Identity endpoints in .env.local.
corepack pnpm db:up
corepack pnpm db:migrate
corepack pnpm dev
```

Open [http://localhost:3010](http://localhost:3010) when the development server
is ready.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Authentication and identity](docs/authentication.md)
- [Eve protocol integration](docs/eve-protocol.md)
- [Human-in-the-loop handling](docs/human-in-the-loop.md)
- [Development](docs/development.md)
- [Deployment](docs/deployment.md)
- [Plans and design history](.plans/README.md)
