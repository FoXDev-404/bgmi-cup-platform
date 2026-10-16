"""Tournament workflow status for the admin FLOW sidebar.

Pure-stdlib computation over one database snapshot (no HTTP).  The payload
carries only counts, statuses and short blocking reasons — never player
names, IGNs, UIDs, phones, emails or room passwords — so it is safe to poll
from every admin page.

Step states
    done       — step finished
    attention  — something needs a look (dupes, corrections, over-capacity…)
    blocked    — short reason why the step cannot run yet (None = runnable)
    current    — the single "you are here" step: the first undone, unblocked
                 core step; forced to "score" while a match is live.

Steps whose features do not exist in this project are not returned at all
(see HIDDEN) — the sidebar must never show a dead link.
"""

import json
import re

import broadcast

# No announcements feature exists yet — step 16 stays hidden.
HIDDEN = ("announce",)

# (phase key, step keys in flow order).  "announce" (16) would sit in
# "after-event" between export and purge.
PHASES = (
    ("registration", ("review", "decide")),
    ("setup", ("groups", "assign", "matches", "overlays", "caster")),
    ("match-day", ("checkin", "room", "start", "score", "end", "publish",
                   "results")),
    ("after-event", ("export", "purge")),
)

# Steps with no completion signal of their own: always clickable, never
# "current", never driving the NEXT card.
INFO_STEPS = ("caster", "export", "purge")

# The steps the "current" pointer scans, in order (phases minus infos).
CORE = tuple(k for _, keys in PHASES for k in keys if k not in INFO_STEPS)


def _setting(conn, key, default=""):
    row = conn.execute("SELECT value FROM settings WHERE key = ?",
                       (key,)).fetchone()
    return row["value"] if row else default


def _dupe_teams(conn):
    """Teams repeating a phone, team name or roster UID (rejected entries
    aside) — the same shapes the approval queue flags (find_conflicts)."""
    teams = [dict(r) for r in conn.execute(
        "SELECT team_id, team_name, cap_phone FROM registrations "
        "WHERE status != 'rejected'")]
    flagged = set()
    by_phone, by_name = {}, {}
    for t in teams:
        ph = re.sub(r"\D", "", str(t["cap_phone"] or ""))
        if ph:
            by_phone.setdefault(ph, set()).add(t["team_id"])
        nm = str(t["team_name"] or "").strip().lower()
        if nm:
            by_name.setdefault(nm, set()).add(t["team_id"])
    for bucket in list(by_phone.values()) + list(by_name.values()):
        if len(bucket) > 1:
            flagged.update(bucket)
    by_uid = {}
    for r in conn.execute(
            "SELECT rm.team_id AS team_id, rm.uid AS uid "
            "FROM roster_members rm JOIN registrations r "
            "ON r.team_id = rm.team_id WHERE r.status != 'rejected'"):
        if r["uid"]:
            by_uid.setdefault(str(r["uid"]), set()).add(r["team_id"])
    for bucket in by_uid.values():
        if len(bucket) > 1:
            flagged.update(bucket)
    return flagged


def _step(done=False, attention=False, blocked=None, counts=None, info=False):
    return {"done": bool(done), "attention": bool(attention),
            "blocked": blocked or None, "info": bool(info), "current": False,
            "counts": counts or {}}


def compute(conn):
    """Full FLOW payload for one snapshot of the tournament database."""
    by_status = {r["status"]: r["c"] for r in conn.execute(
        "SELECT status, COUNT(*) AS c FROM registrations GROUP BY status")}
    pending = by_status.get("pending", 0)
    approved = by_status.get("approved", 0)
    waitlisted = by_status.get("waitlisted", 0)
    rejected = by_status.get("rejected", 0)
    needs = by_status.get("needs_changes", 0)
    total = sum(by_status.values())

    try:
        slot_limit = int(_setting(conn, "slot_limit", "16") or 16)
    except ValueError:
        slot_limit = 16

    open_requests = conn.execute(
        "SELECT COUNT(*) AS c FROM change_requests "
        "WHERE COALESCE(seen, 0) = 0").fetchone()["c"]
    dupes = len(_dupe_teams(conn))

    group_count = conn.execute(
        "SELECT COUNT(*) AS c FROM groups").fetchone()["c"]
    assigned = conn.execute(
        "SELECT COUNT(*) AS c FROM registrations "
        "WHERE status = 'approved' AND group_id IS NOT NULL").fetchone()["c"]
    locked = _setting(conn, "groups_locked", "0") == "1"
    schedule_note = str(_setting(conn, "schedule_note", "") or "").strip()

    matches = broadcast.list_matches(conn)
    upcoming = sorted([m for m in matches if m["status"] == "upcoming"],
                      key=lambda m: m["match_number"])
    live = next((m for m in matches if m["status"] == "live"), None)
    awaiting = sorted(
        [m for m in matches if m["status"] == "awaiting_verification"],
        key=lambda m: m["match_number"])
    published = [m for m in matches if m["status"] == "published"]

    next_match = None
    if upcoming:
        m = upcoming[0]
        size = min(len(broadcast.eligible_teams(conn, m["group_name"])), 16)
        if size < (m["team_count"] or 0):
            size = m["team_count"]
        next_match = {"id": m["id"], "n": m["match_number"],
                      "group": m["group_name"],
                      "checked": m["team_count"], "size": size}

    published_problem = None
    if awaiting:
        published_problem = broadcast.publishable_problem(
            conn, awaiting[0]["id"])

    try:
        disabled = json.loads(broadcast.get_bsetting(conn, "disabled") or "[]")
    except ValueError:
        disabled = []
    if not isinstance(disabled, list):
        disabled = []
    overlays_enabled = len(
        [n for n in broadcast.OVERLAY_NAMES if n not in disabled])

    demo = _setting(conn, "demo_seed", "") == "1"

    steps = {}

    # ---- phase 1: registrations -------------------------------------------
    steps["review"] = _step(
        done=pending == 0, attention=open_requests > 0,
        counts={"pending": pending, "open_requests": open_requests,
                "total": total})
    steps["decide"] = _step(
        done=(approved > 0 and pending == 0 and needs == 0),
        attention=(dupes > 0 or needs > 0 or approved > slot_limit),
        counts={"approved": approved, "slot_limit": slot_limit,
                "pending": pending, "waitlisted": waitlisted,
                "rejected": rejected, "needs_changes": needs,
                "dupe_warnings": dupes})

    # ---- phase 2: setup ----------------------------------------------------
    steps["groups"] = _step(
        done=group_count >= 1,
        blocked=None if approved else "Approve teams first",
        counts={"groups": group_count, "approved": approved})
    steps["assign"] = _step(
        done=(approved > 0 and assigned >= approved),
        blocked=None if group_count else "Create groups first",
        counts={"assigned": assigned, "approved": approved,
                "groups": group_count, "locked": locked})
    steps["matches"] = _step(
        done=len(matches) >= 1,
        blocked=None if group_count else "Create groups first",
        counts={"total": len(matches), "scheduled": len(upcoming),
                "live": 1 if live else 0, "awaiting": len(awaiting),
                "published": len(published)})
    steps["overlays"] = _step(
        done=overlays_enabled > 0,
        counts={"enabled": overlays_enabled, "disabled": len(disabled),
                "total": len(broadcast.OVERLAY_NAMES)})
    steps["caster"] = _step(info=True)

    # ---- phase 3: match day ------------------------------------------------
    if not matches:
        steps["checkin"] = _step(blocked="Create matches first",
                                 counts={"checked": 0, "size": 0,
                                         "match": None})
    elif not next_match:
        steps["checkin"] = _step(done=True,
                                 counts={"checked": 0, "size": 0,
                                         "match": None})
    else:
        steps["checkin"] = _step(
            done=next_match["checked"] >= 2,
            counts={"checked": next_match["checked"],
                    "size": next_match["size"], "match": next_match["n"]})

    steps["room"] = _step(done=bool(schedule_note),
                          counts={"released": bool(schedule_note)})

    if not matches:
        steps["start"] = _step(blocked="Create matches first",
                               counts={"match": None, "checked": 0, "size": 0})
    elif not next_match:
        steps["start"] = _step(done=True,
                               counts={"match": None, "checked": 0, "size": 0})
    else:
        steps["start"] = _step(
            blocked=(None if next_match["checked"] >= 2 else
                     "Open check-in first (min 2 squads)"),
            counts={"match": next_match["n"],
                    "checked": next_match["checked"],
                    "size": next_match["size"]})

    live_info = None
    if live:
        live_info = {"id": live["id"], "n": live["match_number"],
                     "group": live["group_name"],
                     "checked": live["team_count"]}
    scored_before = bool(awaiting or published)
    steps["score"] = _step(
        done=scored_before,
        blocked=(None if (live or scored_before) else "Start a match first"),
        counts={"live": live_info})
    steps["end"] = _step(
        done=bool((not live) and scored_before),
        blocked=(None if (live or scored_before) else "No live match"))
    steps["publish"] = _step(
        done=(len(published) > 0 and not awaiting),
        attention=(published_problem is not None),
        blocked=(None if (awaiting or published) else
                 "No match awaiting verification"),
        counts={"awaiting": [{"id": a["id"], "n": a["match_number"]}
                             for a in awaiting],
                "published": len(published),
                "problem": published_problem})
    steps["results"] = _step(
        done=len(published) > 0,
        counts={"published": len(published), "matches": len(matches)})

    # ---- phase 4: after the event (utilities) ------------------------------
    steps["export"] = _step(info=True)
    steps["purge"] = _step(info=True)

    # ---- the "you are here" pointer ---------------------------------------
    # A live match outranks everything; a freshly ended match awaiting
    # verification outranks the next match's check-in (publish first, then
    # move on to the next lobby).
    current = None
    if live:
        current = "score"
    elif awaiting:
        current = "publish"
    else:
        for key in CORE:
            s = steps[key]
            if not s["done"] and not s["blocked"]:
                current = key
                break
    if current:
        steps[current]["current"] = True

    phases = [{"name": name, "steps": list(keys)} for name, keys in PHASES]
    return {"ok": True, "demo": demo, "current": current,
            "live": live_info, "next_match": next_match,
            "steps": steps, "phases": phases, "hidden": list(HIDDEN)}
