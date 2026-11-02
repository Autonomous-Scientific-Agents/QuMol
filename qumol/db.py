"""SQLite storage.

Tables
------
players        nickname + hashed login token + hashed recovery code (Google ID later)
methods        energy methods (name + version); new potentials are new rows
geometries     unique 3D structures, keyed by their HashMol3D identifier
calculations   results of a method on a geometry (single point, optimization, ...)
submissions    one row per player submission, linking input and optimized geometries
pubchem_cache  remembered PubChem lookups
puzzle_attempts one row per puzzle started: timing, hint, tries, result
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    id            INTEGER PRIMARY KEY,
    nickname      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    token_hash    TEXT NOT NULL UNIQUE,
    recovery_hash TEXT NOT NULL,
    google_sub    TEXT UNIQUE,
    email         TEXT,                      -- optional, only for contacting the player; never shown
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS methods (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    version     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    energy_unit TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS geometries (
    id            TEXT PRIMARY KEY,          -- HashMol3D identifier, e.g. hm3d_v12_p4_H2O_q0m1_b8ad...
    formula       TEXT NOT NULL,
    n_atoms       INTEGER NOT NULL,
    n_heavy       INTEGER NOT NULL,
    charge        INTEGER NOT NULL,
    multiplicity  INTEGER NOT NULL,
    hm_version    TEXT NOT NULL,             -- HashMol3D descriptor version
    hm_precision  REAL NOT NULL,
    descriptor    TEXT NOT NULL,             -- quantized canonical geometry
    xyz           TEXT NOT NULL,             -- standardized geometry as XYZ
    first_player_id INTEGER REFERENCES players(id),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS geometries_formula ON geometries(formula);

CREATE TABLE IF NOT EXISTS calculations (
    id            INTEGER PRIMARY KEY,
    geometry_id   TEXT NOT NULL REFERENCES geometries(id),
    method_id     INTEGER NOT NULL REFERENCES methods(id),
    kind          TEXT NOT NULL,             -- 'single_point' | 'optimization' | 'frequencies' ...
    energy        REAL,
    fmax          REAL,
    converged     INTEGER,
    result_geometry_id TEXT REFERENCES geometries(id),  -- for optimizations: where it ended up
    extra_json    TEXT NOT NULL DEFAULT '{}',          -- forces, frequencies, steps, ...
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (geometry_id, method_id, kind)
);

CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY,
    player_id     INTEGER NOT NULL REFERENCES players(id),
    method_id     INTEGER NOT NULL REFERENCES methods(id),
    input_method  TEXT NOT NULL,             -- 'hand' | 'xyz' | 'smiles' | '2d'
    mode          TEXT NOT NULL DEFAULT 'stable',
    raw_xyz       TEXT NOT NULL,             -- exactly what the player sent
    bonds_json    TEXT NOT NULL,             -- the player's bonding [[i, j, order], ...]
    input_geometry_id     TEXT NOT NULL REFERENCES geometries(id),
    optimized_geometry_id TEXT NOT NULL REFERENCES geometries(id),
    smiles        TEXT,
    inchikey      TEXT,
    formula       TEXT NOT NULL,
    n_heavy       INTEGER NOT NULL,
    e_input       REAL NOT NULL,
    e_opt         REAL NOT NULL,
    stable        INTEGER NOT NULL,
    saddle        INTEGER NOT NULL,
    in_pubchem    INTEGER,                   -- 1 known, 0 not found, NULL unknown
    score         INTEGER NOT NULL,
    breakdown_json TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS submissions_player ON submissions(player_id);
CREATE INDEX IF NOT EXISTS submissions_smiles ON submissions(smiles);
CREATE INDEX IF NOT EXISTS submissions_formula ON submissions(formula, method_id);

CREATE TABLE IF NOT EXISTS puzzle_attempts (
    id          INTEGER PRIMARY KEY,
    player_id   INTEGER NOT NULL REFERENCES players(id),
    puzzle_id   TEXT NOT NULL,
    day         TEXT,                        -- 'YYYY-MM-DD' for a daily puzzle, NULL for free play
    started_at  REAL NOT NULL,               -- unix time on the server
    hint        INTEGER NOT NULL DEFAULT 0,
    tries       INTEGER NOT NULL DEFAULT 0,
    solved_at   REAL,
    rmsd        REAL,
    counted     INTEGER NOT NULL DEFAULT 0,  -- 1 if this solve earned points (first solve only)
    score       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS puzzle_attempts_player ON puzzle_attempts(player_id, puzzle_id);
CREATE INDEX IF NOT EXISTS puzzle_attempts_day ON puzzle_attempts(day);

CREATE TABLE IF NOT EXISTS pubchem_cache (
    smiles     TEXT PRIMARY KEY,
    in_pubchem INTEGER NOT NULL,
    cids_json  TEXT NOT NULL DEFAULT '[]',
    checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
"""

_lock = threading.Lock()


def db_path() -> Path:
    return Path(os.environ.get("QUMOL_DB", "qumol.db"))


def connect(path: str | Path | None = None) -> sqlite3.Connection:
    con = sqlite3.connect(str(path or db_path()), timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


def init(path: str | Path | None = None) -> None:
    con = connect(path)
    with con:
        con.executescript(SCHEMA)
        # columns added after the first release
        cols = {r[1] for r in con.execute("PRAGMA table_info(players)")}
        if "email" not in cols:
            con.execute("ALTER TABLE players ADD COLUMN email TEXT")
    con.close()


@contextmanager
def write_lock():
    """Serialise multi-step writes (records and novelty must not race)."""
    with _lock:
        yield


def method_id(con: sqlite3.Connection, calc) -> int:
    row = con.execute("SELECT id FROM methods WHERE name=? AND version=?", (calc.name, calc.version)).fetchone()
    if row:
        return row["id"]
    cur = con.execute(
        "INSERT INTO methods(name, version, kind, energy_unit, params_json) VALUES (?,?,?,?,?)",
        (calc.name, calc.version, calc.kind, calc.energy_unit, json.dumps(calc.params())),
    )
    return cur.lastrowid


def upsert_geometry(con, gid, n_heavy: int, xyz: str, player_id: int | None) -> None:
    con.execute(
        """INSERT OR IGNORE INTO geometries
           (id, formula, n_atoms, n_heavy, charge, multiplicity, hm_version, hm_precision,
            descriptor, xyz, first_player_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (gid.id, gid.formula, len(gid.std_symbols), n_heavy, gid.charge, gid.multiplicity,
         gid.version, gid.precision, gid.descriptor, xyz, player_id),
    )


def add_calculation(con, geometry_id, mid, kind, energy=None, fmax=None, converged=None,
                    result_geometry_id=None, extra=None) -> None:
    con.execute(
        """INSERT OR IGNORE INTO calculations
           (geometry_id, method_id, kind, energy, fmax, converged, result_geometry_id, extra_json)
           VALUES (?,?,?,?,?,?,?,?)""",
        (geometry_id, mid, kind, energy, fmax, None if converged is None else int(converged),
         result_geometry_id, json.dumps(extra or {})),
    )
