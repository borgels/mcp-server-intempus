# Changelog

## 0.3.2

- Gateway: a masked absence entry (time registration, planned work,
  schedule) keeps no reference to its work type or category at any depth:
  no id, `workTypeId`, `work_type`, `worktype`, `work_category`, URI, name or
  embedded object, nor any field about a category (`category_name`,
  `category_pk` …), so it cannot be linked back to the work type through
  `list_work_types`. Only `workType: { name: "Absence" }` (with the unit for
  a time registration) remains. Catalog unchanged; the MCP server is
  unchanged.

## 0.3.1

Personal data in the embeddable gateway. The MCP server is unchanged.

- A fixed layer on every gateway result, after the handler and before
  redaction (`src/gateway-privacy.ts`):
  - no private contact data or identity numbers: fields named like
    `personal_email` / `personalEmail`, next of kin, relatives, emergency
    contacts, CPR or social security numbers and birth dates are removed, in
    views and raw rows;
  - absence reasons: a time registration (`list_work_reports`,
    `manage_work_report`) with an absence work type (`vacation_or_leave`)
    whose name is not on a fixed allowlist (ferie, feriefri, feriefridag,
    afspadsering, timebank, fridag, helligdag, holiday, vacation, time off in
    lieu) has the work type name `Absence` and no category or remarks;
    planned work and schedules of such a type (`list_planned_work`,
    `list_schedules`, `manage_schedule`) have no free-text fields (remarks,
    notes, comments, descriptions, reasons) and no work type or category
    name (an embedded work type is reduced to its id). An entry without a
    readable work type counts as absence. The work types are read once per call (`GET /work_type/`, now in
    `upstream`); a work type not marked as no absence
    (`vacation_or_leave: false`), or one the company does not have, counts as
    an absence type (fail closed);
  - `get_employee_balances`: a balance whose name is not on the same
    allowlist is named `Absence`; the numbers stay. `list_balances` is
    unchanged.
- `get_resource` refuses, with a fixed text and without a request,
  `work_report`, `historical_work_report`, `explored_employee_balance`,
  `holiday_year_balance`, `holiday_year_balance_work_type`,
  `work_type_balance`, `planned_work_report`, `incident`,
  `missing_report_anomaly` and `schedule`.
- Tool names, risk levels, `broad` and input schemas are unchanged.

## 0.3.0

Embeddable gateway, HTTP transport, upstream client and supply chain.

### Embeddable gateway (`./gateway`)

- New package export `mcp-server-intempus/gateway` in the shape of
  `mcp-server-template`, for hosts that run one instance per tenant in one
  process (see the README, "Embedding" and "Threat model").
- `createIntempusGateway({ apiUser, apiKey, baseUrl?, fetchImpl?, timeoutMs?, maxRetryAfterSeconds?, policy? })`:
  both credentials required and never read from the environment; a gateway
  instance reads no `INTEMPUS_*` variable. The key is sent only to
  `https://intempus.dk`.
- Key admission against a generated corpus of our own texts
  (`scripts/fixed-corpus.mjs`, `src/fixed-corpus.generated.ts`), sealed
  `GatewayConfigError`, sink check on every output with fixed fallbacks, and a
  `SecretRedactor` per instance.
- Host policy (`enableWrites`, `disabledTools`, `audit`) through an
  AsyncLocalStorage call scope; without a policy, writes are off and nothing
  is audited. Audit records name the caller only as an HMAC pseudonym.
- Errors only as the HTTP status and our own fixed texts; Intempus' response
  bodies (its Danish validation messages included) never reach the host. A
  400 body is only compared with a short fixed list of known messages, for
  which the gateway has its own text.
- `intempusToolCatalog`, deeply frozen, with `upstream` and `broad`; names
  without the `intempus_` prefix. It holds the company-wide tools that need
  no identity, run as the admin role: `search_capabilities`, `list_cases`,
  `list_work_types`, `list_employees`, `get_employee`,
  `list_responsibilities`, `list_work_reports`, `list_customers`,
  `list_balances`, `get_employee_balances`, `list_schedules`,
  `list_planned_work`, `list_reference_data`, `get_resource` (broad) and the
  write tools `manage_work_report`, `manage_case`, `manage_customer`,
  `manage_schedule`, `manage_employee`, `manage_contract`,
  `manage_user_access`, `manage_responsibility`.
- Not in the gateway: `whoami`, the self-service and team tools and
  `register_time` (they need the person's own Intempus employee, which the
  host does not know), and the two-step `prepare_admin_change` /
  `commit_prepared_operation` (the host has no confirmation tool). They stay
  in the MCP server.

### Changes to the MCP server

- The cached employee list and company are kept per client instead of per
  base URL, and so is the set of resources that need offset paging.
- Error texts of the server's own checks no longer quote names from
  Intempus data (work type, work model, case names); they name ids and dates.
  Values taken from a stored registration on an update (times, dates) are
  not quoted either, and a registration whose stored date is not a date is
  refused instead of changed.
- The audit log records an error as a fixed code (`http_<status>`,
  `timeout`, `refused`, `error`) instead of its message.
- Published to npm and the MCP Registry from tagged releases.

### HTTP transport, upstream client and supply chain

- HTTP transport fails closed: it refuses to start on a non-loopback bind, or
  with `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit escape hatch.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters without
  whitespace.
- Failed authentication is limited per client address (429 with
  `Retry-After`; `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`).
  Requests with a valid token are never throttled.
- `Host` header check on loopback binds (`MCP_ALLOWED_HOSTS` to override).
- 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON gets 400
  instead of 500; oversized bodies get 413 before they are read.
- `GET /healthz` (unauthenticated) and graceful shutdown on SIGTERM/SIGINT.
- `PORT`, `MCP_MAX_BODY_BYTES` and boolean flags are validated at startup.
- CI runs on pull requests and before every image publish; images are only
  published from `main` and `v*` tags, with SBOM and provenance attestations.
  GitHub Actions are pinned to commit SHAs.
- Dependency updates; `npm audit --omit=dev` is clean.
- Upstream requests no longer follow redirects, so the API key in the
  `Authorization` header is never resent to a redirect target; a redirect is
  reported as an error. Upstream error bodies are read up to 64 KB.
- `INTEMPUS_TIMEOUT_MS` is validated (1-600000) instead of becoming `NaN`.
- The server reports the package version.
- Removed a stray API response sample (`wc.json`) from the repository root.

### Upgrade notes

- A deployment that binds a non-loopback address (for example `0.0.0.0` in a
  container) now needs `MCP_HTTP_TOKEN` of at least 32 characters, or the
  server exits at startup. A 64-character hex token (`openssl rand -hex 32`)
  works unchanged.
- Shorter tokens, tokens with whitespace or a trailing newline, and
  non-numeric or out-of-range numeric settings are rejected at startup.
- New optional variables: `MCP_HTTP_ALLOW_UNAUTHENTICATED`,
  `MCP_ALLOWED_HOSTS`, `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`.
- `INTEMPUS_TIMEOUT_MS` must be an integer between 1 and 600000.
- `INTEMPUS_TRUST_FORWARDED_USER`, `X-MCP-User` and `X-MCP-Roles` behave as
  before.

Also in this release:


- Security hardening:
  - Self-service and admin edits/deletes of a work report are refused when the report's current date is inside the contract's locked period (previously only the new date was checked).
  - `intempus_manage_work_report` and `intempus_manage_schedule` no longer delete; deletes go through `intempus_prepare_admin_change` / `intempus_commit_prepared_operation`.
  - The HTTP transport refuses to start with `INTEMPUS_TRUST_FORWARDED_USER=true` and no `MCP_HTTP_TOKEN`; `X-MCP-User`/`X-MCP-Roles` are honored only under both. The bearer token is compared in constant time.
  - Path parameters are validated (no empty, dot, separator, query/fragment or percent-encoded separator values) before they go into request URLs.
  - `creation_id` is now derived with SHA-256 (UUID version 8) instead of SHA-1 (v5). A retry spanning an upgrade gets a new id.
  - Filter-key validation in `intempus_get_resource` uses a linear-time pattern.

## 0.2.0

- One endpoint instead of one per profile. With `INTEMPUS_PROFILE=roles`, each request carries the user's roles in `X-MCP-Roles`.
  - The gateway derives the header from the user's groups, and it is trusted only with `INTEMPUS_TRUST_FORWARDED_USER=true`.
  - The tools offered are the union of the user's roles (employee, approver, admin), and a user with no role gets 403.
  - A fixed role or comma list in `INTEMPUS_PROFILE` still works (stdio).
- `intempus_whoami` reports `roles` instead of `profile`.

## 0.1.0

Initial release.

- Three profiles from one image (INTEMPUS_PROFILE), each meant for its own
  endpoint and user group:
  - "employee": self-service pinned to the requesting user — profile and
    contracts, own time registrations (list/register/edit/delete while
    unapproved and unlocked), balances (saldi) and planning.
  - "approver": employee tools plus a read-only team view (pending time,
    balances, planning), scoped to the employees/departments/cases the user
    is responsible for in Intempus. No approval tools: the public API
    cannot approve (verified live).
  - "admin": employees (create/update/offboard), contracts, login access,
    approvers and responsibilities, time for anyone, cases (named
    "<number> - <name>"), customers, balances, schedules, planned work,
    reference data and allowlisted generic reads.
- Irreversible admin changes (deletes, contract locked dates, work report
  locks where Intempus enables the feature) only via intempus_prepare_admin_change →
  intempus_commit_prepared_operation: HMAC-signed, 15-minute expiry, bound
  to the preparing user, re-checked against an allowlist at commit.
- Employees are removed by offboarding (end contracts, revoke logins):
  Intempus refuses to delete employees with a user profile.
- Checks Intempus' own rules before writing (contract, locked period, work
  model, interval times, project case) so failures are specific.
- Identity: gateway UPN → exactly one Intempus employee by identity map,
  username or work email (never the private email); fails closed.
- Writes gated by INTEMPUS_ENABLE_WRITES=true; JSONL audit with the signed-in
  user, since Intempus records every change as the API user.
- Client: ApiKey auth, cursor paging with offset fallback for resources
  that reject it, one wait on 429 Retry-After, creation_id idempotency,
  readable tastypie errors, credential redaction.
