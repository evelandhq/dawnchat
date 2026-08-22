# Plans and design history

This directory is the single home for execution plans and implementation-time
design records. These files are historical context, not current operating
documentation; use [`../docs/`](../docs/README.md) for the system as it works
today.

Statuses were checked against the repository code, migrations, tests, and Git
history on 2026-08-22.

## Execution plans

| Plan | Current status | Evidence or remaining work |
| --- | --- | --- |
| [Initial implementation](2026-07-09-eve-chats-initial-implementation.md) | Completed; historical and partly superseded | Initial app shipped in commits `3498894`–`3eb3553`; later work replaced SQLite and the original UI architecture |
| [PostgreSQL storage migration](2026-07-10-postgresql-storage-migration.md) | Completed | PostgreSQL schema, migrations, Compose service, and isolated-schema tests shipped in `f1ab07e` |
| [Agent-first sidebar](2026-07-13-agent-sidebar-entry.md) | Completed | Agent routes, scoped sidebar, composer, health recheck, and tests are present |
| [Eveland Identity provider handoff](2026-07-24-jinshuju-oidc-authenticated-web-chat-handoff.md) | Partially completed | Phases 0–7 closed on 2026-07-27; general OIDC and 金数据 phases 8–9 remain outside the completed milestone |
| [HITL root cause and fix](2026-08-10-hitl-root-cause-and-fix.md) | Completed | Proxy-side ledger, pending-input API, UI behavior, migrations, and tests shipped in `8040f2e`; compatibility audit now covers Eve 0.42–0.44 |
| [Performance execution](2026-08-20-performance-execution-plan.md) | Partially completed | P0–P3 shipped and were verified; P4 projection materialization still requires a separate design review |

## Design records

| Design | Current status |
| --- | --- |
| [Agent-first sidebar](designs/2026-07-13-agent-sidebar-entry-design.md) | Implemented |
| [Agent editing and deletion](designs/2026-07-14-agent-edit-delete-design.md) | Implemented |
| [Agent URL uniqueness](designs/2026-07-14-agent-url-uniqueness-design.md) | Implemented |

When adding a plan, place it directly in `.plans/` (or a clearly named
subdirectory for a non-plan record), add a status near the title, and update
this index when its status changes.
