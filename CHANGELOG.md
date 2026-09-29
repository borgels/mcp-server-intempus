# Changelog

## 0.2.0

- One endpoint instead of one per profile. With `INTEMPUS_PROFILE=roles`, each request carries the user's roles in `X-MCP-Roles`.
  - The the server gateway derives the header from Entra groups (a `roles` table in `hosts.json`), and it is trusted only with `INTEMPUS_TRUST_FORWARDED_USER=true`.
  - The tools offered are the union of the user's roles (employee, approver, admin), and a user with no role gets 403.
  - A fixed role or comma list in `INTEMPUS_PROFILE` still works (stdio).
- `intempus_whoami` reports `roles` instead of `profile`.

## 0.1.0

Initial release.

- Three profiles from one image (INTEMPUS_PROFILE), each meant for its own
  hostname and Entra security group:
  - "employee": self-service pinned to the requesting user — profile and
    contracts, own time registrations (list/register/edit/delete while
    unapproved and unlocked), balances (saldi) and planning.
  - "approver": employee tools plus a read-only team view (pending time,
    balances, planning), scoped to the employees/departments/cases the user
    is responsible for in Intempus. No approval tools: the public API
    cannot approve (verified live).
  - "admin": employees (create/update/offboard), contracts, login access,
    approvers and responsibilities, time for anyone, cases (bpc naming
    "<projektnr> - <navn>"), customers, balances, schedules, planned work,
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
- Writes gated by INTEMPUS_ENABLE_WRITES=true; JSONL audit with the Entra
  user, since Intempus records every change as the API user.
- Client: ApiKey auth, cursor paging with offset fallback for resources
  that reject it, one wait on 429 Retry-After, creation_id idempotency,
  readable tastypie errors, credential redaction.
