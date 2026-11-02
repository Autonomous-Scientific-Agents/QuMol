"""Puzzle mode: build a named molecule by hand, scored against its experimental structure.

Reference structures come from JSON files shaped like puzzles/se100_geometries.json
(the SE100 semi-experimental set ships with the repo). Private sets that can't be
published (CCCBDB) go in a 'puzzles' folder next to the database, or are listed in
QUMOL_PUZZLE_FILES=/path/a.json:/path/b.json. Restart the server after adding one.

Scoring (server-side; the client never sees the reference before solving):
- the molecule must be the target (same SMILES as QuMol computes for the reference),
- Geometry: 1000 * exp(-RMSD / 0.25 Å), RMSD over all atoms after the best symmetry-
  equivalent atom mapping and best rotation (mirror images allowed),
- Speed: up to 500, decaying with time; slower decay for bigger molecules.
The player is given the name, formula and SMILES; the 3D structure is the challenge.
Only a player's first solve of a puzzle (and of each daily puzzle) counts. Puzzle
leaderboards rank by puzzles solved, then by lowest total solve time.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import os
import random
import re
import threading
from pathlib import Path

import numpy as np

from .chem import ChemError, hill_formula, smiles_of, validate

ROOT = Path(__file__).resolve().parent.parent / "puzzles"
DAILY_BINS = [(1, 2), (3, 3), (4, 4), (5, 5), (6, 10)]  # heavy atoms per daily slot, easy to hard
GEOMETRY_MAX, GEOMETRY_SCALE = 1000, 0.25   # points, Å
SPEED_MAX, SPEED_SECONDS_PER_ATOM = 500, 20.0
MAX_MAPPINGS = 5000

_lock = threading.Lock()
_cache: dict | None = None


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def files() -> list[Path]:
    """The public SE100 set, plus private sets: any *.json in a 'puzzles' folder next to the
    database (e.g. data/puzzles/cccbdb_geometries.json), plus QUMOL_PUZZLE_FILES."""
    from . import db

    out = [ROOT / "se100_geometries.json"]
    private = Path(os.path.abspath(db.db_path())).parent / "puzzles"
    if private.is_dir():
        out += sorted(private.glob("*.json"))
    for p in filter(None, os.environ.get("QUMOL_PUZZLE_FILES", "").split(":")):
        out.append(Path(p))
    return [p for p in out if p.exists()]


def load() -> dict[str, dict]:
    """Puzzle id -> puzzle (reference atoms, bonds, SMILES as QuMol computes it, source)."""
    global _cache
    with _lock:
        if _cache is not None:
            return _cache
        out: dict[str, dict] = {}
        for path in files():
            data = json.loads(path.read_text())
            src = data.get("source", {})
            prefix = path.stem.split("_")[0]
            for m in data["molecules"]:
                symbols = [a[0] for a in m["atoms"]]
                coords = np.array([a[1:4] for a in m["atoms"]], dtype=float)
                bonds = [tuple(b) for b in m["bonds"]]
                try:
                    mol = validate(symbols, coords, bonds)
                except ChemError:
                    continue  # not buildable in QuMol
                pid = f"{prefix}-{_slug(m['name'])}"
                if pid in out:
                    continue
                out[pid] = {
                    "id": pid,
                    "name": m["name"],
                    "formula": hill_formula(symbols),  # same format the game shows
                    "smiles": smiles_of(mol),
                    "heavy": mol.n_heavy,
                    "n_atoms": len(symbols),
                    "multiplicity": mol.multiplicity,
                    "symbols": symbols,
                    "coords": coords,
                    "bonds": bonds,
                    "source": m.get("reference") or src,
                }
        _cache = out
        return out


def reset_cache():
    global _cache
    with _lock:
        _cache = None


def public(p: dict) -> dict:
    """What a player sees before solving: name, formula and SMILES, but no coordinates."""
    rad = p["multiplicity"] - 1
    return {
        "id": p["id"], "name": p["name"], "formula": p["formula"], "smiles": p["smiles"], "heavy": p["heavy"],
        "n_atoms": p["n_atoms"],
        "note": f"radical: {rad} unpaired electron{'s' if rad > 1 else ''}" if rad else None,
        "source": (p["source"] or {}).get("text"),
    }


def today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def daily(day: str | None = None) -> list[dict]:
    """The same five puzzles for everyone on a given (UTC) day, from easy to hard."""
    day = day or today()
    rng = random.Random(int(hashlib.sha256(f"qumol-daily-{day}".encode()).hexdigest(), 16))
    pool = sorted(load().values(), key=lambda p: p["id"])
    picks = []
    for lo, hi in DAILY_BINS:
        cands = [p for p in pool if lo <= p["heavy"] <= hi and p not in picks]
        if cands:
            picks.append(rng.choice(cands))
    return picks


# ------------------------------------------------------------------ geometry comparison


def _graph(symbols, bonds):
    """RDKit graph of elements and connectivity only (bond orders and charges ignored)."""
    from rdkit import Chem

    m = Chem.RWMol()
    for s in symbols:
        a = Chem.Atom(s)
        a.SetNoImplicit(True)
        m.AddAtom(a)
    seen = set()
    for a, b, _ in bonds:
        key = (min(a, b), max(a, b))
        if a != b and key not in seen:
            seen.add(key)
            m.AddBond(int(a), int(b), Chem.BondType.SINGLE)
    m = m.GetMol()
    m.UpdatePropertyCache(strict=False)
    return m


def _fit(P, Q):
    """Best rotation (mirror allowed) of Q onto P. Returns rmsd, R, centers."""
    pc, qc = P.mean(0), Q.mean(0)
    H = (Q - qc).T @ (P - pc)
    U, S, Vt = np.linalg.svd(H)
    R = U @ Vt  # orthogonal; may be a reflection, which is fine for comparing shapes
    diff = (Q - qc) @ R - (P - pc)
    return float(np.sqrt((diff ** 2).sum() / len(P))), R, pc, qc


def compare(puzzle: dict, symbols, coords, bonds) -> dict:
    """Best symmetry-equivalent match of the player's structure to the reference."""
    P = np.asarray(coords, dtype=float)
    Q = puzzle["coords"]
    target = _graph(symbols, bonds)
    query = _graph(puzzle["symbols"], puzzle["bonds"])
    maps = target.GetSubstructMatches(query, uniquify=False, useChirality=False, maxMatches=MAX_MAPPINGS)
    if not maps:
        raise ValueError("structure does not match the reference graph")
    best = None
    for m in maps:
        idx = list(m)  # reference atom i -> player atom idx[i]
        r, R, pc, qc = _fit(P[idx], Q)
        if best is None or r < best[0]:
            best = (r, idx, R, pc, qc)
    rmsd, idx, R, pc, qc = best
    aligned = (Q - qc) @ R + pc  # reference atoms in the player's frame
    ghost = [None] * len(P)
    for i, j in enumerate(idx):
        ghost[j] = [round(float(v), 4) for v in aligned[i]]
    diffs = []
    for a, b, o in puzzle["bonds"]:
        ja, jb = idx[a], idx[b]
        mine = float(np.linalg.norm(P[ja] - P[jb]))
        ref = float(np.linalg.norm(Q[a] - Q[b]))
        sym = {1: "–", 2: "=", 3: "≡"}[o]
        diffs.append({"bond": f"{puzzle['symbols'][a]}{sym}{puzzle['symbols'][b]}", "atoms": [ja, jb],
                      "yours": round(mine, 3), "experiment": round(ref, 3), "diff": round(mine - ref, 3)})
    diffs.sort(key=lambda d: -abs(d["diff"]))
    return {"rmsd": rmsd, "ghost": ghost, "diffs": diffs[:3]}


def score(rmsd: float, seconds: float, n_atoms: int) -> list[list]:
    geo = round(GEOMETRY_MAX * math.exp(-rmsd / GEOMETRY_SCALE))
    speed = round(SPEED_MAX * math.exp(-seconds / (SPEED_SECONDS_PER_ATOM * n_atoms)))
    m, s = divmod(int(round(seconds)), 60)
    lines = [["Geometry match", geo, f"RMSD {rmsd:.3f} Å from experiment"],
             ["Speed", speed, f"solved in {m}:{s:02d}"]]
    return lines
