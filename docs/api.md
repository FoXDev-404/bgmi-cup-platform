# HTTP API reference

JSON in / JSON out unless noted. All state-changing admin endpoints require
the session cookie **and** a CSRF token; every response carries
`X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, count}` |
| GET | `/api/csrf` | — | Issues short-lived, IP-bound CSRF token |
| POST | `/api/register` | CSRF | Registers a squad; returns `{ok, teamId, regCode}` |
| POST | `/api/status/lookup` | rate-limited | `{regCode, hint}` → own status only (5/min/IP), includes `updatedAt` |
| POST | `/api/status/request-change` | rate-limited | Team asks for a correction (same bucket) |
| GET | `/api/public/approved` | setting | Names/tags/logos/groups only — 404 unless enabled |
| GET | `/api/public/schedule` | setting | Schedule text + timezone + updatedAt + per-match plan (number/group/map/start time/status) — 404 unless the teams feed is on |
| POST | `/api/admin/login` | rate-limited | Session cookie (httpOnly, SameSite) + CSRF token |
| GET | `/api/admin/registrations` | session | Queue: search/status/sort/counts/slot info/`remaining`/`notify`/conflicts |
| POST | `/api/admin/registrations/<id>/status` | session + CSRF | approve/reject/waitlist/needs_changes (+override) |
| PUT | `/api/admin/registrations/<id>` | session + CSRF | Edit team/captain/roster (audited, PII-masked) |
| GET/POST | `/api/admin/notifications` (+ `/retry`) | session + CSRF | Queue health (counts, failures without addresses), requeue failed jobs |
| * | `/api/admin/groups…`, `/settings`, `/export/*.csv`, `/purge`, `/audit` | session + CSRF | Groups, settings, CSV exports, typed-confirm purge, audit log |

## Registration validation

`POST /api/register` mirrors the client validators server-side (team/tag/guild,
captain fields, 4 starters + 0–2 subs, unique UIDs and IGNs), rejects honeypot
spam, enforces a per-IP rate limit, validates logo **structure** (PNG chunk/CRC
walk, JPEG marker walk, WebP container; magic vs. declared type must agree;
≤ 2 MB, ≤ 8000 px/side, ≤ 40 MP) and writes duplicates as HTTP 409. Team IDs
(`CSM-BG-XXXX`) and Reg IDs (`BGMI26-NNNN`) are allocated by the **server**
inside a `BEGIN IMMEDIATE` transaction, so concurrent submissions can never
collide.
