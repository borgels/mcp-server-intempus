# mcp-server-intempus

MCP server for [Visma Intempus](https://intempus.dk/web-doc/v1/) — time registration, approval, balances (saldi), cases, employees and planning — with three profiles and per-user scoping.

## Profiles

One image, selected by `INTEMPUS_PROFILE`. Each profile runs on its own hostname behind its own Entra security group (see [Deployment](#deployment)).

- **`employee`** — self-service for full- and part-time employees, hard-scoped to the requesting user: `intempus_get_my_profile`, `intempus_list_my_work_reports`, `intempus_register_time`, `intempus_update_my_work_report` / `intempus_delete_my_work_report` (only while neither approved nor locked), `intempus_get_my_balances`, `intempus_get_my_planning`, plus `intempus_list_cases`, `intempus_list_work_types` (own work model only), `intempus_whoami`, `intempus_search_capabilities`.
- **`approver`** — the employee tools plus a read-only team view: `intempus_list_team`, `intempus_list_team_work_reports` (e.g. what awaits approval), `intempus_get_team_balances`, `intempus_get_team_planning`. Scope = the employees, departments and cases the user is responsible for in Intempus (`responsible_for_employee` / `_department` / `_case`). **Approving happens in Intempus itself** — see [below](#not-possible-via-intempus-public-api).
- **`admin`** — company-wide: employees (`intempus_manage_employee` create/update/offboard), contracts, login access, approvers and responsibilities (which is what scopes the approver endpoint), time for anyone, cases, customers, balances, schedules, planned work, reference data, allowlisted generic reads (`intempus_get_resource`), and the two-step `intempus_prepare_admin_change` → `intempus_commit_prepared_operation` for deletes and period locks (contract `locked_date`).

## Guarantees

- **Identity fails closed.** The gateway-verified UPN (`X-MCP-User`, honored when `INTEMPUS_TRUST_FORWARDED_USER=true`) must resolve to exactly one Intempus employee — by `INTEMPUS_IDENTITY_MAP`, then Intempus username, then work email, case-insensitive. The private `personal_email` is never used. Employee and approver tools never accept a foreign employee id as "me"; reports of others read as "not found".
- **Approvers stay in scope.** A user without an approver level in Intempus gets nothing on the approver endpoint, and one with a level but no assignments sees nobody (unless `INTEMPUS_APPROVER_UNASSIGNED_SCOPE=all`).
- **Registrations are checked before they are sent** against the rules Intempus enforces: a contract covering the date, outside the contract's locked period, a work type from the contract's work model, start/end times for interval work types, a case for project work, an open case. `creation_id` (UUID v5 of user + employee + `idempotencyKey`) makes retries safe — verified live: a retry returns the same report.
- **Irreversible admin changes are two-step**: the prepare result is an HMAC-signed preview naming every affected record; commit accepts only an unaltered operation signed by this server, within 15 minutes, by the user who prepared it, whose steps still pass the allowlist. The gateway can gate the commit tool with a separate duty group.
- **Writes need `INTEMPUS_ENABLE_WRITES=true`** — checked in the policy and again in every write path.
- **Attribution.** The API key belongs to one Intempus user, so Intempus' own history shows that user for every change. The JSONL audit (`INTEMPUS_AUDIT_LOG`) records the Entra user, profile, tool and a hash of the arguments (plus the operation hash on commits); requests without `X-MCP-User` are refused when trust is enabled.
- No credentials in tool arguments or results: generated passwords are never echoed, password/PIN fields are stripped from raw reads, `api_key`/`outlook_credential` are not readable.

## Not possible via Intempus' public API

Verified live on 2026-09-29 (details in [docs/api-notes.md](docs/api-notes.md)):

- **Approving time.** `approved` is read-only, and `approved_by_initial` / `approved_by_final` can be set (to a *user profile*) without the report becoming approved. Approval stays in Intempus' web/approval app; the approver endpoint shows what is waiting. Intempus' own MCP server (`mcp.intempus.dk`, needs an `X-Security-Key` from Intempus) advertises bulk approval — the way to get approval into Claude, if wanted.
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

## Relation to bpc (projekt.onedanmark.dk)

bpc keeps its own direct Intempus integration (cases out, approved time in). This server runs alongside it and follows the same case convention: `intempus_manage_case` with `projectNumber` names the case `"<projektnr> - <navn>"`, which is what bpc matches on, and refuses a create when the number or name already exists.

## Configuration

See [`.env.example`](.env.example). Minimal production set: `INTEMPUS_API_USER`, `INTEMPUS_API_KEY`, `INTEMPUS_PROFILE`, `INTEMPUS_TRUST_FORWARDED_USER=true`, `INTEMPUS_ENABLE_WRITES=true`, `INTEMPUS_AUDIT_LOG=/data/audit.jsonl`, `MCP_HTTP_TOKEN` (shared with the gateway), and `INTEMPUS_OPERATION_SECRET` on the admin instance.

## Deployment

Runs on **one-1** behind the Borgels MCP Entra gateway (`bos-server-config/one-1/mcp`), one container per profile:

| Profile | Host | Entra group (ONE tenant) |
|---|---|---|
| `employee` | `intempus.mcp.onedanmark.dk` | `SG-MCP-intempus-one` |
| `approver` | `intempus-godkend.mcp.onedanmark.dk` | `SG-MCP-intempus-godkender-one` |
| `admin` | `intempus-admin.mcp.onedanmark.dk` | `SG-MCP-intempus-admin-one` |
| duty group for `intempus_commit_prepared_operation` | admin host, `toolGroups` | `SG-MCP-intempus-admin-commit-one` |

Group membership must be **direct** (the app emits `ApplicationGroup` claims; nested groups are not included), and each group must be assigned to the Borgels MCP enterprise app. Each person's Entra UPN must match their Intempus username or work email (or be mapped with `INTEMPUS_IDENTITY_MAP`).

## Run

```bash
npm install
npm run dev          # stdio (acting user from INTEMPUS_DEFAULT_USER)
npm run dev:http     # streamable HTTP on :3000/mcp (stateless)
npm test
INTEMPUS_PROFILE=admin SMOKE_USER=you@example.com npm run smoke:live   # read-only, against the real API
```

Docker images: `ghcr.io/borgels/mcp-server-intempus` (published on push to `main`).
