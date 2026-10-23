---
title: "Railway deploy: /data volume required, DB folder auto-created"
author: Rajpal
date: 2026-10-23
branch: main
touches:
  - ".gemini/settings.json"
  - AGENTS.md
  - GEMINI.md
  - README.md
  - docs/features.md
  - docs/testing.md
  - server.py
  - tests/test_api.py
  - railpack.json
  - scripts/create_admin.py
---

## Decided
- Railway needs a persistent volume mounted at /data; railpack.json already points BGMI_DB/BGMI_UPLOADS there.
- server.py now creates BGMI_DB parent folders before sqlite3.connect so a fresh deploy boots even before the volume exists, and warns under RAILWAY_ENVIRONMENT that storage is ephemeral.

## Tried and ruled out
- Assuming railpack.json was invalid: `railpack prepare` v0.43.0 accepts it and plans Python 3.13.16 + `python server.py`.
- Assuming Node/Playwright was broken: `npm ci` and `npx playwright test` are green; the only failure was a missing Chromium download (fixed with `npx playwright install chromium`).

## Watch out
- Without the /data volume the app starts but registrations are lost on redeploy.
- Create the admin account once with BGMI_ADMIN_USER/BGMI_ADMIN_PASSWORD + scripts/create_admin.py; there are no default credentials.
