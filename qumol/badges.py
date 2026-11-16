"""Badges: ladders of titles for counts (molecules, puzzles, cooking, points) and one-off
achievements. The titles, icons and rules live in badges.toml so they are easy to edit; the
file is re-read when it changes. Nothing is stored per badge: badges are worked out from a
player's submissions, puzzle solves and reported events, so they apply to past play too."""

from __future__ import annotations

import json
import re
import sqlite3
import tomllib
from pathlib import Path

from . import db

PATH = Path(__file__).with_name("badges.toml")
STATS = {"molecules", "puzzles", "cooked", "points"}
EVENTS = {"lesson", "quiz"}  # what the game may report with POST /api/badges/event
_cache: dict = {"mtime": None, "data": None}


def catalog() -> dict:
    """The parsed and checked badges.toml (cached until the file changes)."""
    mtime = (str(PATH), PATH.stat().st_mtime_ns)
    if _cache["mtime"] != mtime:
        data = tomllib.loads(PATH.read_text(encoding="utf-8"))
        check(data)
        _cache.update(mtime=mtime, data=data)
    return _cache["data"]


def check(data: dict) -> None:
    """Raise ValueError on a mistake in badges.toml, naming the entry."""
    keys = set()
    for lad in data.get("ladder", []):
        for f in ("key", "name", "stat", "tiers"):
            if f not in lad:
                raise ValueError(f"ladder {lad.get('key', '?')}: missing {f}")
        if lad["stat"] not in STATS:
            raise ValueError(f"ladder {lad['key']}: unknown stat {lad['stat']!r}")
        ats = [t["at"] for t in lad["tiers"]]
        if ats != sorted(set(ats)) or any(not (t.get("icon") and t.get("title")) for t in lad["tiers"]):
            raise ValueError(f"ladder {lad['key']}: tiers need icon, title and increasing 'at'")
        keys.add(lad["key"])
    for b in data.get("badge", []):
        for f in ("key", "icon", "title", "rule"):
            if not b.get(f):
                raise ValueError(f"badge {b.get('key', '?')}: missing {f}")
        if b["key"] in keys:
            raise ValueError(f"badge {b['key']}: duplicate key")
        keys.add(b["key"])
        kind, _, arg = b["rule"].partition(":")
        ok = (kind == "smiles" and arg) or (kind == "bond" and arg in ("2", "3")) \
            or (kind in ("ring", "accident") and not arg) or (kind == "event" and arg in EVENTS)
        if not ok:
            raise ValueError(f"badge {b['key']}: bad rule {b['rule']!r}")


def _has_ring(smiles: str) -> bool:
    return bool(re.search(r"[0-9%]", re.sub(r"\[[^\]]*\]", "", smiles)))


def player_facts(con: sqlite3.Connection, player_id: int) -> dict:
    """Everything the badge rules look at, for one player."""
    rows = con.execute(
        "SELECT smiles, input_method, bonds_json FROM submissions WHERE player_id=? AND stable=1 AND smiles IS NOT NULL",
        (player_id,)).fetchall()
    built = {r["smiles"] for r in rows if r["input_method"] != "cook"}
    cooked = {r["smiles"] for r in rows if r["input_method"] == "cook"}
    orders = set()
    for r in rows:
        try:
            orders.update(int(b[2]) for b in json.loads(r["bonds_json"]) if len(b) > 2)
        except (ValueError, TypeError, IndexError):
            pass
    n_cooked = sum(r["input_method"] == "cook" for r in rows)
    puzzles = con.execute("SELECT COUNT(DISTINCT puzzle_id) FROM puzzle_attempts WHERE player_id=? AND counted=1",
                          (player_id,)).fetchone()[0]
    events = {r[0] for r in con.execute("SELECT event FROM player_events WHERE player_id=?", (player_id,))}
    return {
        "stats": {"molecules": len(built), "puzzles": puzzles, "cooked": n_cooked,
                  "points": db.player_total(con, player_id)},
        "smiles": built | cooked, "built": built, "cooked": cooked, "orders": orders, "events": events,
    }


def _earned(rule: str, f: dict) -> bool:
    kind, _, arg = rule.partition(":")
    if kind == "smiles":
        return any(s.strip() in f["smiles"] for s in arg.split(","))
    if kind == "bond":
        return int(arg) in f["orders"]
    if kind == "ring":
        return any(_has_ring(s) for s in f["smiles"])
    if kind == "accident":
        return bool(f["cooked"] - f["built"])
    if kind == "event":
        return arg in f["events"]
    return False


def player_badges(con: sqlite3.Connection, player_id: int) -> dict:
    """Ladders with the player's count and which tiers they have, and the one-off badges."""
    cat, f = catalog(), player_facts(con, player_id)
    ladders = []
    for lad in cat.get("ladder", []):
        v = f["stats"][lad["stat"]]
        tiers = [{"key": f"{lad['key']}-{t['at']}", "at": t["at"], "icon": t["icon"], "title": t["title"],
                  "earned": v >= t["at"]} for t in lad["tiers"]]
        ladders.append({"key": lad["key"], "name": lad["name"], "unit": lad.get("unit", ""), "value": v, "tiers": tiers})
    badges = [{"key": b["key"], "icon": b["icon"], "title": b["title"], "hint": b.get("hint", ""),
               "earned": _earned(b["rule"], f)} for b in cat.get("badge", [])]
    earned = [t for lad in ladders for t in lad["tiers"] if t["earned"]] + [b for b in badges if b["earned"]]
    return {"ladders": ladders, "badges": badges, "earned": [e["key"] for e in earned]}


def record_event(con: sqlite3.Connection, player_id: int, event: str) -> None:
    if event not in EVENTS:
        raise ValueError(f"unknown event {event!r}")
    con.execute("INSERT OR IGNORE INTO player_events(player_id, event) VALUES (?,?)", (player_id, event))
