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
- **Headers** — `X-Content-Type-Options: nosniff` and `Referrer-Policy:
  strict-origin-when-cross-origin` on every response.
- **Path safety** — `.py/.db/.db-wal/.db-shm/.pyc`, dotfiles and `..` escapes
  are blocked; `uploads/` resolves only inside `BGMI_UPLOADS`.
- **Privacy** — `/status` misses are byte-identical regardless of whether the
  Reg ID or the hint was wrong; notification/queue payloads carry team ids, not
  addresses; exports are recorded in the audit log.
- **Integrity** — multi-statement admin writes run in `BEGIN IMMEDIATE`
  transactions; rejected registrations can never leave orphan logo files.
