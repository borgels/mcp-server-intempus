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
- **Locking work reports** (`work_report/bulk/`) needs Intempus' "work report state" feature, which is not enabled on every account (401 "…only be updated if the feature is enabled"). The prepare kind `lock_work_reports` works once Intempus enables it; period locks via the contract's `locked_date` work today.
- **Deleting employees.** Intempus refuses (409) while a user profile exists, every employee gets one, and user profiles cannot be deleted. Employees are removed by **offboarding**: open contracts end on the last day and backend/approval logins are revoked.

## Intempus facts this server relies on

Verified against a production account on 2026-09-29; details in [docs/api-notes.md](docs/api-notes.md).

- Auth `Authorization: ApiKey <username>:<key>`; the username is **case-sensitive**.
- `employee` cannot be filtered on email, and username has no case-insensitive filter, so identity is matched in memory (cached 60 s).
- `explored_employee_balance` and `schedule` answer HTTP 500 to cursor pagination; the client falls back to offset paging.
- Relations are URIs in lists but embedded objects in some detail responses (e.g. `work_type.work_model`); both are handled.
- Holiday balances accrue at month end: a balance "as of today" does not include this month's accrual yet.
- Rate limit is 500 requests/minute **per Intempus user**, shared with every integration using the same key.

## Relation to other Intempus integrations

Other systems may keep their own direct Intempus integration (cases out, approved time in). This server follows the common case convention: `intempus_manage_case` with `projectNumber` names the case `"<projektnr> - <navn>"`, and refuses a create when the number or name already exists.

## Configuration

See [`.env.example`](.env.example). Minimal production set: `INTEMPUS_API_USER`, `INTEMPUS_API_KEY`, `INTEMPUS_PROFILE=roles`, `INTEMPUS_TRUST_FORWARDED_USER=true`, `INTEMPUS_ENABLE_WRITES=true`, `INTEMPUS_AUDIT_LOG=/data/audit.jsonl`, `INTEMPUS_OPERATION_SECRET`, and `MCP_HTTP_TOKEN` (shared with the gateway).

## Deployment

One container (`INTEMPUS_PROFILE=roles`) behind an authenticating MCP gateway. The gateway maps the user's groups to roles (`X-MCP-Roles`: `employee`, `approver`, `admin`) and can restrict `intempus_commit_prepared_operation` to a separate group. Each person's sign-in address must match their Intempus username or work email (or be mapped with `INTEMPUS_IDENTITY_MAP`).

## Install

```bash
npx mcp-server-intempus
```

Runs the stdio server from npm. Configure it with the environment variables in `.env.example`.

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

## Embedding (`./gateway`)

`mcp-server-intempus/gateway` lets a host application run the tools
in-process instead of over MCP, in the same shape as `mcp-server-template`.
One process can run several gateway instances, for example one per tenant.

```ts
import { createIntempusGateway, intempusToolCatalog } from 'mcp-server-intempus/gateway';

const gateway = createIntempusGateway({
  apiUser: tenant.intempusUser,
  apiKey: tenant.intempusKey,
  policy: { enableWrites: true, audit: record => log(record) },
});
const result = await gateway.callTool('list_work_reports', { from: '2026-09-01', to: '2026-09-30' }, { caller: 'user-1', requestId: 'r-1' });
```

The module exports:

- `createIntempusGateway({ apiUser, apiKey, baseUrl?, fetchImpl?, timeoutMs?, maxRetryAfterSeconds?, policy? })`.
  `apiUser` is the Intempus API user (its user name; case matters) and
  `apiKey` that user's key; they are sent as `Authorization: ApiKey <user>:<key>`.
  Both are required and never read from the environment. `baseUrl` defaults
  to `https://intempus.dk/web/v1/` and must be an https address on
  `intempus.dk`: the key is sent nowhere else. `timeoutMs` defaults to 30000.
  A gateway instance reads no `INTEMPUS_*` variable at all (not the
  credentials, `INTEMPUS_BASE_URL`, `INTEMPUS_TIMEOUT_MS`,
  `INTEMPUS_ENABLE_WRITES`, `INTEMPUS_AUDIT_LOG`, `INTEMPUS_PROFILE`,
  `INTEMPUS_IDENTITY_MAP`, `INTEMPUS_TRUST_FORWARDED_USER` or
  `INTEMPUS_OPERATION_SECRET`).
- `gateway.tools` (the tools enabled on the instance) and
  `gateway.callTool(name, input, { caller, requestId })`, which returns
  `{ content, structuredContent?, isError?, failure? }`. Names are accepted as the
  gateway name (`list_cases`) or the MCP server name (`intempus_list_cases`),
  in any case. Input is validated with the tool's zod schema before anything
  is sent, and unknown fields are refused. The audit records of the call hold
  `caller` only as an HMAC pseudonym (a per-process key) and a request id of
  the server's own; the host's `requestId` is not written. An error is
  recorded as a fixed code (`http_<status>`, `timeout`, `refused` or
  `error`), never as its message.
- `intempusGatewayTools`: the definitions (`name`, `title`, `description`,
  `riskLevel`, `enabledByDefault`, `inputSchema` as JSON Schema derived from
  the zod schema the call is validated with).
- `intempusToolCatalog`: the same tools, deeply frozen, with `upstream`
  (method and path template of every Intempus request the tool may make,
  relative to the base URL) and `broad` (true when the input chooses what
  kind of thing is read). Hosts can build their own permission model from it
  without creating an instance.
- `GatewayConfigError` and the types (`IntempusGatewayOptions`,
  `IntempusGateway`, `InstancePolicy`, `AuditSink`, `GatewayToolDefinition`,
  `GatewayToolCatalogEntry`, `GatewayUpstreamOperation`, `GatewayToolResult`,
  `GatewayCallContext` and the JSON types).

The host does not know which Intempus employee a person is, so the gateway
offers only company-wide tools that need no identity, run as the admin role:

| Tool | Risk | Default | Broad | Intempus requests |
|---|---|---|---|---|
| `search_capabilities` | read | on | no | none |
| `list_cases` | read | on | no | `GET /case/` |
| `list_work_types` | read | on | no | `GET /work_type/`, `GET /employee/{id}/` |
| `list_employees` | read | on | no | `GET /employee/` |
| `get_employee` | read | on | no | `GET /employee/{id}/`, `GET /userprofile/` |
| `list_responsibilities` | read | on | no | `GET /responsible/`, `GET /responsible_for_{employee,department,case}/`, `GET /employee/` |
| `list_work_reports` | read | on | no | `GET /work_report/`, `GET /work_type/` |
| `list_customers` | read | on | no | `GET /customer/` |
| `list_balances` | read | on | no | `GET /balance/` |
| `get_employee_balances` | read | on | no | `GET /employee/`, `GET /balance/`, `GET /explored_employee_balance/` |
| `list_schedules` | read | on | no | `GET /schedule/`, `GET /work_type/` |
| `list_planned_work` | read | on | no | `GET /planned_work_report/`, `GET /work_type/` |
| `list_reference_data` | read | on | no | `GET /<kind>/` for the twelve reference lists |
| `get_resource` | read | on | **yes** | `GET /{resource}/`, `GET /{resource}/{id}/` |
| `manage_work_report` | write | off | no | reads of employee, work types, case and work report; `POST /work_report/`, `PATCH /work_report/{id}/` |
| `manage_case` | write | off | no | `GET /case/`, `POST /case/`, `PATCH /case/{id}/`, `GET /case/{id}/` |
| `manage_customer` | write | off | no | `GET /company/`, `POST /customer/`, `PATCH /customer/{id}/`, `GET /customer/{id}/` |
| `manage_schedule` | write | off | no | `GET /company/`, `POST /schedule/`, `PATCH /schedule/{id}/`, `GET /schedule/{id}/`, `GET /work_type/` |
| `manage_employee` | write | off | no | employee, company and userprofile reads; `POST /employee/`, `POST /contract/`, `PATCH /employee/{id}/`, `PATCH /contract/{id}/`, `PATCH /userprofile/{id}/` |
| `manage_contract` | write | off | no | `POST /contract/`, `PATCH /contract/{id}/`, `GET /contract/{id}/` |
| `manage_user_access` | write | off | no | `GET /userprofile/`, `POST /userprofile/`, `PATCH /userprofile/{id}/`, `GET /employee/{id}/` |
| `manage_responsibility` | write | off | no | `POST` and `DELETE` on `/responsible/` and `/responsible_for_{employee,department,case}/` |

The catalog holds the exact list; a test checks it against the requests each
tool makes. `get_resource` is broad: it reads any resource of an allowlist by
name. Not in the gateway: `whoami`, the self-service tools (`*_my_*`), the team
tools (`list_team*`, `get_team_*`) and `register_time` (they act as the
signed-in person's own Intempus employee), and `prepare_admin_change` / `commit_prepared_operation`
(irreversible deletes and period locks, which need a two-step confirmation
the host has no tool for). They stay in the MCP server.

**Personal data.** Whatever role the host gives a caller, a fixed layer on
every gateway result (after the handler, before redaction;
`src/gateway-privacy.ts`) leaves out:

- private contact data and identity numbers: fields named like
  `personal_email` / `personalEmail`, next of kin, relatives, emergency
  contacts, CPR or social security numbers and birth dates, in views and raw
  rows;
- absence reasons: a time registration (`list_work_reports`,
  `manage_work_report`) with an absence work type (`vacation_or_leave`) whose
  name is not exactly one of the neutral names (ferie, feriefri, feriefridag,
  afspadsering, timebank, fridag, helligdag, holiday, vacation, time off in
  lieu, case-insensitive) has the work type name `Absence` and no category or
  remarks, and planned work and schedules of such a type have no free-text
  fields (remarks, notes, comments, descriptions) and no work type or
  category name; an entry without a readable work type counts as absence; a work type not marked as no absence
  (`vacation_or_leave: false`), or one the company does not have, counts as
  an absence type (fail closed). A masked entry keeps no reference to its
  work type or category (no id, URI or embedded object, at any depth), so it
  cannot be linked back through `list_work_types`; only
  `workType: { name: "Absence" }` remains;
- in `get_employee_balances`, the name of a balance that is not neutral
  (`Absence` instead; the numbers and the employee stay, but no `balanceId`,
  unit or other reference to the definition). `list_balances` and
  `list_work_types` show the company's own set-up unchanged.

`get_resource` refuses, with a fixed text and without a request, the
resources that hold people's absence or its reasons in raw form:
`work_report`, `historical_work_report`, `explored_employee_balance`,
`holiday_year_balance`, `holiday_year_balance_work_type`,
`work_type_balance`, `planned_work_report`, `incident`,
`missing_report_anomaly` and `schedule`.

**Instance policy.** With `policy: { enableWrites, disabledTools, audit }`
the host decides the instance's policy: the write tools run only with
`enableWrites: true`, the disabled tools are left out of `tools` (and out of
`search_capabilities`) and refused when called, and the audit records go to
`audit` (none without it). `disabledTools` must name gateway tools. A sink
that throws on a start record refuses the call. Without `policy` the instance
has writes off, no disabled tools and no audit. Every call runs in a call
scope of its own (AsyncLocalStorage), so a call made from inside another
instance's call never inherits its policy, sink, redactor or caller. There is
no process-wide registry of keys, and the cached employees and company are
kept per instance.

**Results.** A successful result has `structuredContent` and one text block:
a short summary, a blank line, and the same data as compact JSON. Passwords,
PINs and keys are never returned: the server strips them from Intempus rows,
a password it or Intempus generates for a new employee is never part of a
result, and the gateway replaces the value of every credential-named field
(`password`, `current_password`, `pin`, `api_key`, `secret`, `token` …) with
`‹redacted›`. The data is redacted twice against the instance's key (exact
value, URL- and JSON-encoded forms and any piece of 6 characters or more, in
strings, object keys and the string form of numbers and booleans) and for
credential-shaped text before it is serialised.

**Errors.** An error result carries our own English text, never Intempus'
response body (including its Danish validation messages), a redirect's
`Location` or the configured address. An HTTP failure reads
`Intempus API request failed with HTTP <status>`, followed by
` | <our hint>` and ` | retry-after=<seconds>s` where Intempus sends one, so a
host can map it by status. Such a result also has
`failure: { httpStatus, requestId? }`: the status, and the vendor's request
id from a response header (`REQUEST_ID_HEADERS` in `src/errors.ts`) only when
it is a hex id of 8 to 64 characters (one run of hex digits, or groups of
four or more joined by single hyphens, as in a UUID) and does not hold the
shape of a personal number, so a host can count failures without reading
their text. The hints are fixed (400, 401, 403, 404, 405, 409,
429, 500, 502, 503, 504, redirects). For a 400 the gateway compares the body
with a short fixed list of known Intempus validation messages
(`KNOWN_PROBLEMS` in `src/errors.ts`) and, on a match, uses our own text for
it instead of the 400 hint; nothing else of the body is kept. Other errors
are `Intempus did not answer within the time limit. Retry later.`,
`Intempus could not be reached.` (with a system error code from a fixed
list), `The Intempus call failed.`, `Invalid input for <tool>: …`,
`Unsupported Intempus gateway tool.`, the policy refusals
(`Writes are disabled: …`, `tool is disabled on this instance by the embedding host: …`)
and the server's own checks (a closed case, a locked period, a duplicate,
a missing field), which quote only ids, dates and the caller's own input.

### Threat model

What the gateway guarantees about the API key, and what it does not.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`). The standalone MCP server, configured from the environment
for one key, keeps best-effort redaction: its errors and audit records are
redacted, but it is not held to these guarantees, and it shows Intempus'
validation messages so a failed write says what to fix.

**Guaranteed:**

- **(a) The key never reaches anything persisted or shared:** audit sinks,
  logs, error texts. Errors are our own texts; audit records and everything
  a gateway instance returns are redacted with the instance's own key before
  they leave it.
- **(b) No Intempus-controlled free text in errors.** An error carries our
  own fixed text, the HTTP status, numbers we parse (Retry-After), ids and
  dates of a fixed shape, and our text for a validation message from a fixed
  list we wrote down; never a response body, an Intempus message, a name
  from Intempus data, a redirect's `Location`, or the message of an error
  thrown while calling Intempus. Errors never quote a configuration value.
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The key is only sent to `intempus.dk`,
  and redirects are never followed.

**Not guaranteed (residual risk):** Intempus deliberately echoing the
customer's own key back in data. Results are redacted on a best-effort basis
(the exact key, its encoded forms and any piece of 6 characters or more); a
key that comes back otherwise transformed (split into pieces shorter than 6
characters, reversed, hashed) is not recognised. Such data reaches only the
tenant whose key it is. The API user name is not treated as a secret.

**Key admission and the sink check.** A gateway accepts only a key of
printable ASCII (0x21-0x7E) of at least 16 characters that shares no piece
of 6 characters with a string literal in `src/`
(`src/fixed-corpus.generated.ts`, kept up to date by a test; run
`node scripts/fixed-corpus.mjs` after changing a text), with the fixed
fallbacks (`src/fallbacks.ts`) or with the tool list. A refused key throws
`GatewayConfigError` when the gateway is created, before anything is built
or sent; the refusal is a fixed text that holds no piece of the key, and
every error a gateway throws has no `cause` and a `stack` of only
`name: message`. As the very last step, every output (the tool list, each
result as a whole, each audit record) is checked in its final form, and one
that still holds a piece of the key is replaced by a fixed fallback.

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

