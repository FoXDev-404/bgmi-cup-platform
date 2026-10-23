# Security notes

- **Sessions** — `bgmi_admin` cookie is httpOnly/SameSite, stored hashed.
  Two lifetimes apply: an **absolute cap** (`BGMI_SESSION_TTL`, default 14 d)
  and an **idle timeout** (`BGMI_SESSION_IDLE_TTL`, default 8 h) that revokes
  an untouched session on its next request.
- **Login throttle** — per-IP (10/5 min) *and* per-username (5 failures/5 min,
  cleared on success), plus a dummy scrypt for unknown users so response times
  don't reveal whether an account exists. Failure messages never distinguish
  "no such user" from "wrong password".
- **Same-origin writes** — every state-changing admin request checks
  `Origin`/`Referer` against `Host` (403 on mismatch); CSRF tokens remain
  required on top of that.
- **Proxy-aware IPs** — `Cf-Connecting-Ip` is trusted only from loopback;
  `X-Real-IP` is trusted only from loopback/private/CGNAT peers (or when
  `RAILWAY_ENVIRONMENT` is set). Railway's edge overwrites `X-Real-IP`, so
  rate-limit and CSRF buckets stay per-visitor instead of collapsing into the
  proxy bucket, while a direct public client cannot spoof the header.
- **Headers** — `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy`, and a strict CSP
  with `frame-ancestors 'self'` on every response. HSTS (`max-age=31536000`)
  is added when the trusted proxy forwards `X-Forwarded-Proto: https`.
- **Live streams** — SSE connections are capped globally
  (`BGMI_SSE_MAX_CLIENTS`, default 500) and per IP (`BGMI_SSE_MAX_PER_IP`,
  default 50); the slot is released on every disconnect path.
- **CSV exports** — player-controlled cells beginning with `=`, `+`, `-`,
  `@`, tab or CR are prefixed with `'` to stop spreadsheet formula injection;
  numeric cells are preserved and exports are sent with `Cache-Control:
  no-store`.
- **Input caps** — guild names are limited to 48 characters and e-mail
  addresses to 254 characters in addition to the existing per-field format
  checks.
- **Path safety** — `.py/.db/.db-wal/.db-shm/.pyc`, dotfiles and `..` escapes
  are blocked; `uploads/` resolves only inside `BGMI_UPLOADS`.
- **Privacy** — `/status` misses are byte-identical regardless of whether the
  Reg ID or the hint was wrong; notification/queue payloads carry team ids, not
  addresses; exports are recorded in the audit log.
- **Integrity** — multi-statement admin writes run in `BEGIN IMMEDIATE`
  transactions; rejected registrations can never leave orphan logo files.
