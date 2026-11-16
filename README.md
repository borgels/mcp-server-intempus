# mcp-server-intempus

MCP server for [Visma Intempus](https://intempus.dk/web-doc/v1/) — time registration, approval, balances (saldi), cases, employees and planning — with employee, approver and admin roles on one endpoint and per-user scoping.

This is an independent, unofficial project. It is not developed, endorsed or supported by Visma or Intempus.

## Roles

One server, one endpoint. Every user holds one or more **roles**, and the tools they see are the union of those roles. With `INTEMPUS_PROFILE=roles` the roles arrive per request in `X-MCP-Roles`. The gateway derives that header from the user's groups in its identity provider, and it is honored only together with `INTEMPUS_TRUST_FORWARDED_USER=true`; a user with no role gets 403. A fixed role or list (e.g. `INTEMPUS_PROFILE=employee` or `employee,approver`) gives every request the same roles, which is useful for stdio.

- **`employee`** — self-service for full- and part-time employees, hard-scoped to the requesting user:
  - `intempus_get_my_profile`, `intempus_list_my_work_reports`
  - `intempus_register_time`
  - `intempus_update_my_work_report` / `intempus_delete_my_work_report`, only while the report is neither approved nor locked
  - `intempus_get_my_balances`, `intempus_get_my_planning`
- **`approver`** — a read-only team view:
  - `intempus_list_team`
  - `intempus_list_team_work_reports`, e.g. what awaits approval
  - `intempus_get_team_balances`, `intempus_get_team_planning`

  Scope is the employees, departments and cases the user is responsible for in Intempus (`responsible_for_employee` / `_department` / `_case`), or everyone with `INTEMPUS_APPROVER_UNASSIGNED_SCOPE=all` when Intempus has no assignments. **Approving happens in Intempus itself** — see [below](#not-possible-via-intempus-public-api).
- **`admin`** — company-wide:
  - employees (`intempus_manage_employee` create/update/offboard), contracts, login access
  - approvers and responsibilities, which is what scopes the approver role
  - time for anyone, cases, customers, balances, schedules, planned work, reference data
  - allowlisted generic reads (`intempus_get_resource`)
  - the two-step `intempus_prepare_admin_change` → `intempus_commit_prepared_operation` for deletes and period locks (contract `locked_date`)

Every role gets `intempus_whoami` (shows your roles and linked employee), `intempus_search_capabilities`, `intempus_list_cases` and `intempus_list_work_types`.

## Guarantees

- **Identity fails closed.** The gateway-verified UPN (`X-MCP-User`, honored when `INTEMPUS_TRUST_FORWARDED_USER=true` and `MCP_HTTP_TOKEN` is set) must resolve to exactly one Intempus employee — by `INTEMPUS_IDENTITY_MAP`, then Intempus username, then work email, case-insensitive. The private `personal_email` is never used. Employee and approver tools never accept a foreign employee id as "me"; reports of others read as "not found".
- **Approvers stay in scope.** A user without an approver level in Intempus gets nothing on the approver endpoint, and one with a level but no assignments sees nobody (unless `INTEMPUS_APPROVER_UNASSIGNED_SCOPE=all`).
- **Registrations are checked before they are sent** against the rules Intempus enforces: a contract covering the date, outside the contract's locked period, a work type from the contract's work model, start/end times for interval work types, a case for project work, an open case. Editing or deleting an existing report is also refused when its current date lies in the locked period, so time cannot be moved out of or removed from a closed period. `creation_id` (a name-based UUID, SHA-256, of user + employee + `idempotencyKey`) makes retries safe — a retry returns the same report.
- **Irreversible admin changes are two-step** (deleting work reports and schedules included — `intempus_manage_work_report` and `intempus_manage_schedule` only create and update): the prepare result is an HMAC-signed preview naming every affected record; commit accepts only an unaltered operation signed by this server, within 15 minutes, by the user who prepared it, whose steps still pass the allowlist. The gateway can gate the commit tool with a separate duty group.
- **Forwarded headers need the bearer token.** The HTTP transport refuses to start with `INTEMPUS_TRUST_FORWARDED_USER=true` and no `MCP_HTTP_TOKEN`; `X-MCP-User` and `X-MCP-Roles` are honored only under both. The token is compared in constant time.
- **Writes need `INTEMPUS_ENABLE_WRITES=true`** — checked in the policy and again in every write path.
- **Attribution.** The API key belongs to one Intempus user, so Intempus' own history shows that user for every change. The JSONL audit (`INTEMPUS_AUDIT_LOG`) records the signed-in user, roles, tool and a hash of the arguments (plus the operation hash on commits); requests without `X-MCP-User` are refused when trust is enabled.
- No credentials in tool arguments or results: generated passwords are never echoed, password/PIN fields are stripped from raw reads, `api_key`/`outlook_credential` are not readable.

## Not possible via Intempus' public API

Verified live on 2026-09-29 (details in [docs/api-notes.md](docs/api-notes.md)):

- **Approving time.** `approved` is read-only, and `approved_by_initial` / `approved_by_final` can be set (to a *user profile*) without the report becoming approved. Approval stays in Intempus' web/approval app; the approver role shows what is waiting. Intempus' own MCP server (`mcp.intempus.dk`, needs an `X-Security-Key` from Intempus) advertises bulk approval — the way to get approval into Claude, if wanted.
- **Locking work reports** (`work_report/bulk/`) needs Intempus' "work report state" feature, which ONE's account does not have (401 "…only be updated if the feature is enabled"). The prepare kind `lock_work_reports` works once Intempus enables it; period locks via the contract's `locked_date` work today.
- **Deleting employees.** Intempus refuses (409) while a user profile exists, every employee gets one, and user profiles cannot be deleted. Employees are removed by **offboarding**: open contracts end on the last day and backend/approval logins are revoked.

## Intempus facts this server relies on

Verified against a production account on 2026-09-29; details in [docs/api-notes.md](docs/api-notes.md).

- Auth `Authorization: ApiKey <username>:<key>`; the username is **case-sensitive**.
- `employee` cannot be filtered on email, and username has no case-insensitive filter, so identity is matched in memory (cached 60 s).
- `explored_employee_balance` and `schedule` answer HTTP 500 to cursor pagination; the client falls back to offset paging.
- Relations are URIs in lists but embedded objects in some detail responses (e.g. `work_type.work_model`); both are handled.
- Holiday balances accrue at month end: a balance "as of today" does not include this month's accrual yet.
- Rate limit is 500 requests/minute **per Intempus user**, shared with every integration using the same key (e.g. bpc).

## Relation to other Intempus integrations

Other systems may keep their own direct Intempus integration (cases out, approved time in). This server follows the common case convention: `intempus_manage_case` with `projectNumber` names the case `"<projektnr> - <navn>"`, and refuses a create when the number or name already exists.

## Configuration

See [`.env.example`](.env.example). Minimal production set: `INTEMPUS_API_USER`, `INTEMPUS_API_KEY`, `INTEMPUS_PROFILE=roles`, `INTEMPUS_TRUST_FORWARDED_USER=true`, `INTEMPUS_ENABLE_WRITES=true`, `INTEMPUS_AUDIT_LOG=/data/audit.jsonl`, `INTEMPUS_OPERATION_SECRET`, and `MCP_HTTP_TOKEN` (shared with the gateway).

## Deployment

One container (`INTEMPUS_PROFILE=roles`) behind an authenticating MCP gateway. The gateway maps the user's groups to roles (`X-MCP-Roles`: `employee`, `approver`, `admin`) and can restrict `intempus_commit_prepared_operation` to a separate group. Each person's sign-in address must match their Intempus username or work email (or be mapped with `INTEMPUS_IDENTITY_MAP`).

## Run

```bash
npm install
npm run dev          # stdio (acting user from INTEMPUS_DEFAULT_USER)
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
INTEMPUS_PROFILE=admin SMOKE_USER=you@example.com npm run smoke:live   # read-only; roles: employee | approver | admin   # read-only, against the real API
```

Docker images: `ghcr.io/borgels/mcp-server-intempus` (published from `main` after CI passes, and from `v*` tags). The container binds `0.0.0.0`, so it needs `MCP_HTTP_TOKEN` (at least 32 characters).

### HTTP transport settings

The HTTP transport serves `POST /mcp` (stateless Streamable HTTP) and an
unauthenticated `GET /healthz`. It binds to `127.0.0.1` unless told otherwise.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | – | Bearer token for `/mcp`: at least 32 printable ASCII characters, e.g. `openssl rand -hex 32`. **Required** on a non-loopback bind and with `MCP_ALLOW_ANY_ORIGIN=true`; the server refuses to start otherwise. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Start without a token where one would be required. Only for setups where access is restricted by other means; logs a warning. |
| `MCP_ALLOWED_ORIGINS` | – | Comma-separated browser origins allowed to call `/mcp`. Default: localhost origins. Requests without an `Origin` header (server-to-server) are not affected. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any browser origin. Requires `MCP_HTTP_TOKEN`. |
| `MCP_ALLOWED_HOSTS` | – | Comma-separated host names accepted in the `Host` header. Default: on a loopback bind only `localhost`, `127.0.0.1`, `[::1]` and the bind address; no check on other binds. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Request body limit; larger requests get 413. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address within the window before further failures get 429. `0` disables. Requests with a valid token are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for `MCP_AUTH_FAILURE_LIMIT`. |

Invalid values (a non-numeric `PORT`, a misspelt boolean) stop the server at
startup with a message naming the variable. Rejected requests get a JSON error
(401 with `WWW-Authenticate: Bearer`, 400 for invalid JSON, 413 for oversized
bodies) and one log line on stderr. The server shuts down gracefully on
SIGTERM/SIGINT.

## Security model

- The server calls Intempus as one API user (`INTEMPUS_API_USER` /
  `INTEMPUS_API_KEY`); Intempus records every change as that user. The JSONL
  audit log ties each change to the signed-in user.
- Per-user scoping (employee/approver tools pinned to `X-MCP-User`, roles from
  `X-MCP-Roles`) relies on the identity-aware gateway in front of the server:
  it authenticates users, sets those headers itself and is the only caller
  holding `MCP_HTTP_TOKEN`. The headers are only honoured with
  `INTEMPUS_TRUST_FORWARDED_USER=true` and a token. Per-user authorization
  belongs in that gateway.
- `MCP_HTTP_TOKEN` decides who may call the server at all. It does not tell
  users apart.
- Tool access is not data access. Roles limit which tools a user is offered,
  but the API user decides what data the server can reach. Give the API user
  no more rights in Intempus than the admin role needs.
- The HTTP server does not terminate TLS. Run it behind a reverse proxy that
  does, or keep it on a private network.

