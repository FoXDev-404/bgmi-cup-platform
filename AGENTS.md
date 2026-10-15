<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->

## Workflow — safe inspect / code / test (BGMI registration app)

Stack: Python 3 stdlib only (`server.py`, SQLite), plain HTML/CSS/JS, Playwright
(chromium). No venv, no requirements, no npm scripts. Never `pip install` here.

Commands (all isolated — real `registrations.db` untouched):
- Start dev server: `python server.py` (http://127.0.0.1:8080; `PORT`, `BGMI_DB`,
  `BGMI_UPLOADS` env overrides, `server.py:44-50`).
- API suite (self-hosted temp DB): `python test_api.py`
- Admin suite (needs server on :8080 with temp DB): start server with
  `PORT=8080 BGMI_DB=<temp> BGMI_UPLOADS=<tempdir>`, then `python test_admin.py`
- Browser tests: `npx playwright test` (`tests/`, chromium only).

Rules:
- `git status --short` before editing; never `reset --hard`, `clean -fd`,
  force-push, history rewrites, or discarding user changes without explicit OK.
- No commits/pushes/branch deletes/remote changes unless explicitly instructed.
- Read source before editing; small targeted edits; `git diff --check` + `git diff`
  after. No unrelated refactoring. No new dependencies.
- Done = suites above pass + diff clean + no secrets in tracked files
  (`.env` is gitignored, never commit it).
