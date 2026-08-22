# Agent Edit and Delete Design

Status: **Implemented.**
Status checked: 2026-08-22.

## Goal

Allow users to edit and delete existing Eve agent connections from the Agent management page. Editing covers the agent name, normalized base URL, and authentication configuration. Deleting an agent permanently removes the agent and all chats, messages, and events associated with it.

## Confirmed Decisions

- Each Agent card on `/agents` exposes `Edit` and `Delete` actions.
- Editing uses a dedicated `/agents/[agentId]/edit` page; `/agents/[agentId]` remains the new-chat page.
- Every successful edit automatically runs a health check, including name-only edits.
- Existing secrets are never sent to the browser. Leaving a secret field empty preserves the saved secret when the authentication type is unchanged.
- Changing to a different authenticated mode requires credentials for the new mode. Changing to `none` clears saved authentication configuration.
- Deleting an Agent cascades to all of its chats, messages, and events.
- The delete dialog requires the user to type the Agent name exactly before its destructive button is enabled.
- Name confirmation is a client-side safety measure only. The DELETE API does not validate or accept the confirmation name.
- Editing must use the same base-URL normalization, database uniqueness constraint, conflict response, and user-facing conflict message as Agent creation.

## User Interface

### Agent Management List

Each card rendered by `AgentList` gains two actions:

- `Edit` links to `/agents/[agentId]/edit`.
- `Delete` opens a confirmation dialog for that Agent.

The delete dialog names the selected Agent and warns that the Agent and all associated chat data will be permanently deleted. It contains an input for the Agent name. The destructive button stays disabled until the input value is exactly equal to the current Agent name. Matching is case-sensitive and does not trim the input.

While deletion is pending, the dialog controls are disabled to prevent duplicate requests. On success, the dialog closes and the Agent list refreshes. On failure, the dialog remains open, preserves the confirmation input, and shows a generic deletion error.

The target record is always selected by Agent ID. Duplicate Agent names therefore do not make deletion ambiguous.

### Edit Page

`/agents/[agentId]/edit` is a server-rendered page that loads the Agent directly from the repository. A missing Agent renders the existing not-found behavior.

The page reuses a generalized Agent connection form in edit mode. It pre-populates:

- name;
- normalized Base URL;
- authentication type;
- the non-secret custom Header Name, when applicable; and
- whether the selected authentication mode already has a saved secret.

Bearer tokens and custom header values are never pre-populated or serialized to the browser. Their empty edit fields mean “keep the saved value” only when the authentication type remains unchanged. The form labels or helper text make that behavior explicit.

Saving sends the full non-secret configuration plus any newly entered secret to the update API. A successful response redirects to `/agents` and refreshes server-rendered data. An unreachable health result is still a successful edit: the Agent is saved and displayed with `unreachable` status.

## Authentication Editing Rules

The server loads the current connection before constructing the updated authentication configuration.

| Existing type | Submitted type | Submitted secret | Result |
| --- | --- | --- | --- |
| `none` | `none` | Not applicable | Keep no authentication |
| `bearer` | `bearer` | Empty | Preserve the existing bearer token |
| `bearer` | `bearer` | Present | Replace the bearer token |
| `header` | `header` | Empty | Preserve the existing header value; use the submitted valid Header Name |
| `header` | `header` | Present | Replace the header value; use the submitted valid Header Name |
| Any type | `none` | Not applicable | Clear the encrypted authentication configuration |
| A different type | `bearer` | Empty | Reject validation; a new bearer token is required |
| A different type | `bearer` | Present | Save the new bearer token |
| A different type | `header` | Empty | Reject validation; a valid Header Name and new header value are required |
| A different type | `header` | Present | Save the valid Header Name and new header value |

If stored authentication data is missing or invalid when preservation is requested, the update fails without changing the connection. All newly supplied secrets are encrypted with the existing authentication encryption mechanism before persistence.

## API and Data Flow

Add `src/app/api/agents/[agentId]/route.ts` with:

- `PATCH /api/agents/[agentId]` to update an existing connection;
- `DELETE /api/agents/[agentId]` to delete an existing connection by ID.

PATCH accepts the same full non-secret fields as creation (`name`, `baseUrl`, and `authType`) plus the optional credential fields required by the authentication transition rules. DELETE accepts no request body.

### Update

The PATCH flow is:

1. Parse JSON and validate the editable connection fields.
2. Load the existing Agent or return `404`.
3. Resolve the encrypted authentication configuration using the transition rules above.
4. Normalize the Base URL with the same validator used during creation.
5. Persist the edited connection and reset its health state before checking it.
6. Run the Eve health check against the newly saved configuration.
7. Persist `healthy` or `unreachable` with a new `lastCheckedAt` value.
8. Return the existing redacted Agent/check response shape without secrets.

The remote health check is not part of a database transaction. If the remote Agent is unreachable, the check returns `unreachable`; the configuration remains saved. Validation and authentication-preservation failures occur before the configuration write. If persisting the final health result fails after the configuration write, PATCH returns `500` and leaves the saved Agent in the reset `unknown` state so it can be checked again.

The repository adds a focused update operation rather than implementing the edit as delete-and-create. The Agent ID and its existing chat relationships remain stable.

### Base URL Uniqueness

Another active task is adding normalized Base URL uniqueness for Agent creation. This feature consumes that work rather than duplicating it:

- Updating without changing the normalized URL does not conflict with the same row.
- Updating to another Agent's normalized URL raises the same repository domain error used by creation.
- PATCH translates that error to the same `409` status and response body as POST.
- The edit form renders the same duplicate-URL message as the creation form.

Implementation must preserve and integrate with the other task's in-progress changes to schema, migrations, repository errors, API tests, and form error handling.

### Delete

DELETE removes the Agent by ID and returns `404` if it does not exist. It does not accept a request body for name confirmation. On success it returns `204 No Content`.

The existing foreign keys perform the destructive operation atomically:

`agent_connections` → `chats` → `messages` and `events`

No new cascade migration is required. The repository exposes a small delete operation and relies on the database constraints as the source of truth.

## Errors and Security

- Invalid JSON or editable fields: `400`.
- Missing Agent: `404`.
- Base URL owned by another Agent: the same `409` response used by creation.
- Unexpected persistence or encryption failure: generic `500`.
- Remote health failure after a valid update: successful response with `unreachable` status, not an API error.
- API responses and client props never include a bearer token, custom header value, or encrypted authentication payload.
- The delete name input protects against accidental clicks in the supported UI, but direct API callers can delete by ID without supplying the Agent name. This is an accepted product decision.

## Components and Boundaries

- `AgentList` owns Agent-card actions and selects the Agent to delete.
- A focused client-side delete dialog owns confirmation input, pending state, DELETE request, and deletion feedback.
- The Agent connection form supports create and edit modes while sharing field validation and duplicate-URL feedback.
- The edit page loads and converts stored Agent data into safe initial form values.
- The Agent API module owns request validation, authentication transition logic, health-check orchestration, and response mapping.
- The repository owns stable-ID update and delete persistence operations.

These boundaries keep the existing new-chat route and chat components unchanged.

## Testing and Acceptance

### Repository

- Update all editable connection fields without changing the Agent ID or its chats.
- Delete an Agent and verify its chats, messages, and events are removed by cascade.
- Return the expected missing-record result for update and delete.

### API

- Edit an Agent and automatically health-check the new configuration.
- Save a valid edit whose remote Agent is unreachable and return `unreachable`.
- Preserve bearer and header secrets when their replacement fields are empty and the authentication type is unchanged.
- Require new credentials when switching to bearer or custom-header authentication.
- Clear credentials when switching to no authentication.
- Never return submitted, preserved, or encrypted secrets.
- Return the creation-compatible `409` response when an edit uses another Agent's normalized Base URL.
- Allow an Agent to retain its own normalized Base URL.
- Return `404` for unknown Agent IDs.
- Delete an Agent by ID, return `204`, and verify cascaded chat/message/event removal.

### UI

- Render Edit and Delete actions for each connected Agent.
- Pre-populate only safe edit fields and explain empty-secret preservation.
- Submit edit mode to PATCH, show validation and duplicate-URL errors, then redirect and refresh on success.
- Keep Delete disabled until the case-sensitive Agent name matches exactly.
- Issue DELETE only after confirmation, prevent duplicate submission, refresh on success, and preserve the dialog/input with an error on failure.

### Regression

- Existing Agent creation, discovery, manual health check, Agent new-chat page, and sidebar behavior continue to pass.
- Run focused repository, Agent API, and Agent UI tests, followed by the full test suite and typecheck.
- The user performs any browser verification after starting the development service themselves; implementation work will not start a long-running service.

## Out of Scope

- Recovering deleted Agent or chat data.
- Server-side Agent-name confirmation for deletion.
- Bulk editing or deletion.
- Editing an Agent from the new-chat page or sidebar.
- Changing Base URL normalization or uniqueness semantics established by the other active task.
