"""QuMol web server: JSON API plus the game page.

Run:  uvicorn qumol.app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import re
import secrets
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi import Path as PathParam
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import time

from . import __version__, db, puzzles, scoring
from .calculators import available, get_calculator
from .chem import ChemError, hill_formula, smiles_from_graph, smiles_of, validate
from .security import (BodyLimit, SecurityHeaders, compute_slot, ensure_disk_space, env_int, limiter,
                       one_at_a_time, read_cache)

# Abuse limits (override with environment variables if needed)
SIGNUPS_PER_IP_HOUR = env_int("QUMOL_SIGNUPS_PER_IP_HOUR", 20)
RECOVERS_PER_IP_HOUR = env_int("QUMOL_RECOVERS_PER_IP_HOUR", 10)
RECOVERS_PER_NICK_HOUR = env_int("QUMOL_RECOVERS_PER_NICK_HOUR", 5)
SUBMITS_PER_PLAYER_MIN = env_int("QUMOL_SUBMITS_PER_MIN", 20)
SUBMITS_PER_PLAYER_DAY = env_int("QUMOL_SUBMITS_PER_DAY", 1000)
SUBMITS_PER_IP_MIN = env_int("QUMOL_SUBMITS_PER_IP_MIN", 40)
SUBMITS_PER_IP_DAY = env_int("QUMOL_SUBMITS_PER_IP_DAY", 3000)
READS_PER_IP_MIN = env_int("QUMOL_READS_PER_IP_MIN", 120)

log = logging.getLogger("qumol")
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
NICK_RE = re.compile(r"^[A-Za-z0-9_\-. ]{2,24}$")
EMAIL_RE = re.compile(r"^[^@\s<>\"']{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")


def clean_email(value: str | None) -> str | None:
    """Optional contact email: empty means none; anything else must look like an address."""
    v = (value or "").strip()
    if not v:
        return None
    if len(v) > 254 or not EMAIL_RE.match(v):
        raise HTTPException(400, "That email address doesn't look right (you can leave it empty)")
    return v

@asynccontextmanager
async def lifespan(_app):
    db.init()
    if os.environ.get("QUMOL_METHOD", "toyff") != "toyff":
        # Load the ML potential in the background at startup, so the first player doesn't wait
        # for the download, and so a broken setup shows up in the log right away.
        threading.Thread(target=_warm_up, daemon=True).start()
    yield


def _warm_up():
    from .chem import validate

    try:
        calc = get_calculator()
        water = validate(["O", "H", "H"], [[0, 0, 0], [0.96, 0, 0], [-0.24, 0.93, 0]], [(0, 1, 1), (0, 2, 1)])
        res = calc.optimize(water)
        log.info("Energy method %s %s ready (water: %.4f %s)", calc.name, calc.version, res.e_opt, calc.energy_unit)
    except Exception:
        log.exception("Energy method failed to load. Submissions will fail until this is fixed")


_docs = os.environ.get("QUMOL_DOCS") == "1"  # API docs are off unless asked for
app = FastAPI(title="QuMol", version=__version__, lifespan=lifespan,
              docs_url="/docs" if _docs else None, redoc_url=None,
              openapi_url="/openapi.json" if _docs else None)
app.add_middleware(SecurityHeaders)
app.add_middleware(BodyLimit)


@app.exception_handler(RequestValidationError)
async def _validation_error(_request: Request, exc: RequestValidationError):
    # Never echo the submitted values back (they may be huge, or NaN, which can't be JSON-encoded).
    detail = [{"loc": list(e.get("loc", [])), "msg": e.get("msg", "Invalid input")} for e in exc.errors()][:10]
    return JSONResponse({"detail": detail}, status_code=422)


def client_ip(request: Request) -> str:
    # uvicorn --proxy-headers fills this from X-Forwarded-For set by Tailscale (trusted: 127.0.0.1)
    return request.client.host if request.client else "unknown"


def get_con():
    con = db.connect()
    try:
        yield con
    finally:
        con.close()


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _recovery_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(4))


def current_player(authorization: str | None = Header(default=None), con=Depends(get_con)):
    if not authorization or not authorization.lower().startswith("bearer ") or len(authorization) > 200:
        raise HTTPException(401, "Missing token")
    row = con.execute(
        "SELECT id, nickname FROM players WHERE token_hash=?", (_hash(authorization[7:].strip()),)
    ).fetchone()
    if not row:
        raise HTTPException(401, "Unknown token")
    return dict(row)


# ------------------------------------------------------------------ players


class NewPlayer(BaseModel):
    nickname: str = Field(max_length=64)
    email: str | None = Field(default=None, max_length=300)


class Profile(BaseModel):
    email: str | None = Field(default=None, max_length=300)


class Recover(BaseModel):
    nickname: str = Field(max_length=64)
    recovery_code: str = Field(max_length=32)


@app.post("/api/players")
def create_player(body: NewPlayer, request: Request, con=Depends(get_con)):
    limiter.hit("signup:" + client_ip(request), SIGNUPS_PER_IP_HOUR, 3600)
    ensure_disk_space(db.db_path())
    nick = body.nickname.strip()
    if not NICK_RE.match(nick):
        raise HTTPException(400, "Nickname: 2–24 letters, numbers, spaces, _ - or .")
    email = clean_email(body.email)
    token, code = secrets.token_urlsafe(32), _recovery_code()
    try:
        with con:
            cur = con.execute(
                "INSERT INTO players(nickname, token_hash, recovery_hash, email) VALUES (?,?,?,?)",
                (nick, _hash(token), _hash(code), email),
            )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "That nickname is taken")
    return {"player_id": cur.lastrowid, "nickname": nick, "token": token, "recovery_code": code}


@app.post("/api/players/recover")
def recover(body: Recover, request: Request, con=Depends(get_con)):
    ip = client_ip(request)
    limiter.hit("recover:" + ip, RECOVERS_PER_IP_HOUR, 3600)
    # keyed on IP + nickname, so nobody can lock someone else out of their own account
    limiter.hit(f"recover-nick:{ip}:{body.nickname.strip().lower()}", RECOVERS_PER_NICK_HOUR, 3600)
    row = con.execute(
        "SELECT id, nickname, recovery_hash FROM players WHERE nickname=?", (body.nickname.strip(),)
    ).fetchone()
    if not row or not secrets.compare_digest(row["recovery_hash"], _hash(body.recovery_code.strip().upper())):
        raise HTTPException(401, "Nickname or recovery code is wrong")
    token = secrets.token_urlsafe(32)
    with con:  # issuing a new token logs out the old device
        con.execute("UPDATE players SET token_hash=? WHERE id=?", (_hash(token), row["id"]))
    return {"player_id": row["id"], "nickname": row["nickname"], "token": token}


@app.get("/api/me")
def me(player=Depends(current_player), con=Depends(get_con)):
    r = con.execute(
        """SELECT COALESCE(SUM(score),0) AS total, COUNT(*) AS n,
                  COUNT(DISTINCT CASE WHEN stable=1 THEN smiles END) AS molecules,
                  COUNT(DISTINCT CASE WHEN stable=1 AND in_pubchem=0 THEN smiles END) AS discoveries
           FROM submissions WHERE player_id=?""",
        (player["id"],),
    ).fetchone()
    email = con.execute("SELECT email FROM players WHERE id=?", (player["id"],)).fetchone()["email"]
    return {**player, **dict(r), "email": email}


@app.patch("/api/me")
def update_me(body: Profile, player=Depends(current_player), con=Depends(get_con)):
    """Set or clear the optional contact email."""
    email = clean_email(body.email)
    with con:
        con.execute("UPDATE players SET email=? WHERE id=?", (email, player["id"]))
    return {"email": email}


# ------------------------------------------------------------------ submissions


Coord = Annotated[float, Field(ge=-500, le=500, allow_inf_nan=False)]
Index = Annotated[int, Field(ge=0, le=1000)]


class Atom(BaseModel):
    el: str = Field(max_length=2)
    x: Coord
    y: Coord
    z: Coord


class Submission(BaseModel):
    atoms: list[Atom] = Field(..., min_length=1, max_length=150)
    bonds: list[tuple[Index, Index, Annotated[int, Field(ge=1, le=3)]]] = Field(default_factory=list, max_length=300)
    input_method: Literal["hand", "xyz", "smiles", "2d", "example"] = "hand"
    mode: Literal["stable"] = "stable"


@app.post("/api/submissions")
def create_submission(body: Submission, request: Request, player=Depends(current_player), con=Depends(get_con)):
    ip, pid = client_ip(request), player["id"]
    limiter.hit(f"submit:{pid}", SUBMITS_PER_PLAYER_MIN, 60)
    limiter.hit(f"submit-day:{pid}", SUBMITS_PER_PLAYER_DAY, 86400)
    limiter.hit(f"submit-ip:{ip}", SUBMITS_PER_IP_MIN, 60)
    limiter.hit(f"submit-ip-day:{ip}", SUBMITS_PER_IP_DAY, 86400)
    ensure_disk_space(db.db_path())
    try:
        with one_at_a_time(f"player:{pid}"):
            return scoring.submit(
                con, pid, [a.el for a in body.atoms], [[a.x, a.y, a.z] for a in body.atoms],
                body.bonds, body.input_method, body.mode, compute=compute_slot,
            )
    except (ChemError, ValueError) as e:
        raise HTTPException(400, str(e))
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Submission failed in the energy calculation")
        raise HTTPException(503, f"The energy model failed ({type(e).__name__}). The server log has details.")


class GraphAtom(BaseModel):
    el: str = Field(max_length=2)


class Graph(BaseModel):
    atoms: list[GraphAtom] = Field(..., min_length=1, max_length=150)
    bonds: list[tuple[Index, Index, Annotated[int, Field(ge=1, le=3)]]] = Field(default_factory=list, max_length=300)


@app.post("/api/smiles")
def live_smiles(body: Graph, request: Request):
    """SMILES of the molecule being built (for the live display)."""
    limiter.hit("smiles:" + client_ip(request), 240, 60)
    try:
        return {"smiles": smiles_from_graph([a.el for a in body.atoms], body.bonds)}
    except ChemError as e:
        raise HTTPException(400, str(e))


@app.get("/api/submissions/mine")
def my_submissions(limit: int = Query(50, ge=1, le=500), player=Depends(current_player), con=Depends(get_con)):
    rows = con.execute(
        """SELECT id, formula, smiles, score, stable, in_pubchem, input_method, created_at
           FROM submissions WHERE player_id=? ORDER BY id DESC LIMIT ?""",
        (player["id"], limit),
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/geometries/{gid}.xyz", response_class=PlainTextResponse)
def geometry_xyz(gid: str = PathParam(max_length=200), con=Depends(get_con)):
    row = con.execute("SELECT xyz FROM geometries WHERE id=?", (gid,)).fetchone()
    if not row:
        raise HTTPException(404, "No such geometry")
    return row["xyz"]


# ------------------------------------------------------------------ puzzles


def _puzzle_status(con, pid: int, puzzle_id: str, day: str | None):
    """Score of the counted solve, or None. Free play (day None) and each daily puzzle
    are counted separately, whichever comes first."""
    row = con.execute(
        """SELECT MAX(score) AS score FROM puzzle_attempts
           WHERE player_id=? AND puzzle_id=? AND counted=1 AND day IS ?""",
        (pid, puzzle_id, day),
    ).fetchone()
    return row["score"]


@app.get("/api/puzzles/daily")
def puzzles_daily(request: Request, authorization: str | None = Header(default=None), con=Depends(get_con)):
    limiter.hit("read:" + client_ip(request), READS_PER_IP_MIN, 60)
    day = puzzles.today()
    pid = None
    if authorization:
        try:
            pid = current_player(authorization, con)["id"]
        except HTTPException:
            pid = None
    out = []
    for i, p in enumerate(puzzles.daily(day)):
        item = {**puzzles.public(p), "slot": i + 1}
        if pid:
            item["solved_score"] = _puzzle_status(con, pid, p["id"], day)
        out.append(item)
    return {"day": day, "puzzles": out, "total_puzzles": len(puzzles.load())}


class PuzzleStart(BaseModel):
    puzzle_id: str | None = Field(default=None, max_length=80)
    daily: bool = False


@app.post("/api/puzzles/start")
def puzzle_start(body: PuzzleStart, player=Depends(current_player), con=Depends(get_con)):
    pid = player["id"]
    limiter.hit(f"puzzle-start:{pid}", 60, 60)
    ensure_disk_space(db.db_path())
    pool = puzzles.load()
    day = puzzles.today() if body.daily else None
    if body.daily:
        ids = [p["id"] for p in puzzles.daily(day)]
        if body.puzzle_id not in ids:
            raise HTTPException(404, "That isn't one of today's puzzles")
        p = pool[body.puzzle_id]
    elif body.puzzle_id:
        if body.puzzle_id not in pool:
            raise HTTPException(404, "No such puzzle")
        p = pool[body.puzzle_id]
    else:  # random: prefer puzzles this player hasn't solved yet
        done = {r["puzzle_id"] for r in con.execute(
            "SELECT DISTINCT puzzle_id FROM puzzle_attempts WHERE player_id=? AND counted=1", (pid,))}
        fresh = [q for q in pool.values() if q["id"] not in done] or list(pool.values())
        p = secrets.choice(fresh)
    with con:
        cur = con.execute("INSERT INTO puzzle_attempts(player_id, puzzle_id, day, started_at) VALUES (?,?,?,?)",
                          (pid, p["id"], day, time.time()))
    already = _puzzle_status(con, pid, p["id"], day) is not None
    return {"attempt_id": cur.lastrowid, "puzzle": puzzles.public(p), "daily": body.daily, "day": day,
            "practice": already}


def _attempt(con, attempt_id: int, pid: int):
    row = con.execute("SELECT * FROM puzzle_attempts WHERE id=? AND player_id=?", (attempt_id, pid)).fetchone()
    if not row:
        raise HTTPException(404, "No such puzzle attempt")
    return row


class PuzzleSolve(BaseModel):
    attempt_id: int = Field(ge=1)
    atoms: list[Atom] = Field(..., min_length=1, max_length=150)
    bonds: list[tuple[Index, Index, Annotated[int, Field(ge=1, le=3)]]] = Field(default_factory=list, max_length=300)


@app.post("/api/puzzles/solve")
def puzzle_solve(body: PuzzleSolve, player=Depends(current_player), con=Depends(get_con)):
    pid = player["id"]
    limiter.hit(f"puzzle-solve:{pid}", 30, 60)
    ensure_disk_space(db.db_path())
    row = _attempt(con, body.attempt_id, pid)
    if row["solved_at"] is not None:
        raise HTTPException(409, "Already solved. Start a new puzzle")
    p = puzzles.load().get(row["puzzle_id"])
    if p is None:
        raise HTTPException(404, "That puzzle is no longer available")
    symbols = [a.el for a in body.atoms]
    coords = [[a.x, a.y, a.z] for a in body.atoms]
    try:
        mol = validate(symbols, coords, body.bonds, max_radicals=len(symbols) * 4)
        smiles = smiles_of(mol)
    except ChemError as e:
        raise HTTPException(400, str(e))
    if smiles != p["smiles"] or mol.multiplicity != p["multiplicity"]:
        with con:
            con.execute("UPDATE puzzle_attempts SET tries=tries+1 WHERE id=?", (row["id"],))
        tip = None
        if mol.radicals > p["multiplicity"] - 1:
            tip = "Some atoms have free bonds. Did you forget hydrogens? (H+ fills them.)"
        elif len(symbols) != p["n_atoms"]:
            tip = f"The target has {p['n_atoms']} atoms; yours has {len(symbols)}."
        elif hill_formula(symbols) != p["formula"]:
            tip = f"Same number of atoms, but the target's formula is {p['formula']}."
        else:
            tip = "Right atoms, but they're connected differently. Check the bonds and bond orders."
        return {"correct": False, "message": f"That isn't {p['name']} yet.", "tip": tip, "tries": row["tries"] + 1}
    try:
        cmp = puzzles.compare(p, symbols, coords, body.bonds)
    except ValueError as e:
        raise HTTPException(400, str(e))
    now = time.time()
    seconds = max(0.0, now - row["started_at"])
    lines = puzzles.score(cmp["rmsd"], seconds, p["n_atoms"])
    total = max(0, sum(l[1] for l in lines))
    with db.write_lock(), con:
        first = _puzzle_status(con, pid, p["id"], row["day"]) is None
        cur = con.execute(
            "UPDATE puzzle_attempts SET solved_at=?, rmsd=?, counted=?, score=? WHERE id=? AND solved_at IS NULL",
            (now, cmp["rmsd"], int(first), total if first else 0, row["id"]))
    if cur.rowcount == 0:  # a second Check on the same attempt got here first
        raise HTTPException(409, "Already solved. Start a new puzzle")
    return {
        "correct": True, "puzzle": puzzles.public(p), "smiles": p["smiles"],
        "rmsd": round(cmp["rmsd"], 4), "seconds": round(seconds, 1), "tries": row["tries"] + 1,
        "lines": lines, "score": total if first else 0, "practice": not first,
        "ghost": cmp["ghost"], "diffs": cmp["diffs"], "source": p["source"],
    }


# ------------------------------------------------------------------ leaderboards

LEADERBOARDS = {
    "overall": ("Top scorers", "SUM(s.score)", ""),
    "hand": ("Hand builders", "SUM(s.score)", "AND s.input_method='hand'"),
    "xyz": ("XYZ submitters", "SUM(s.score)", "AND s.input_method='xyz'"),
    "weekly": ("This week", "SUM(s.score)", "AND s.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    "small": ("Small-molecule masters (≤ 5 heavy atoms)", "SUM(s.score)", "AND s.n_heavy <= 5"),
    "discoveries": ("Discoverers (not in PubChem)", "COUNT(DISTINCT s.smiles)", "AND s.stable=1 AND s.in_pubchem=0"),
    "molecules": ("Collectors (distinct molecules)", "COUNT(DISTINCT s.smiles)", "AND s.stable=1"),
}


PUZZLE_BOARDS = {  # ranked by puzzles solved, then by lowest total solve time
    "puzzle_daily": "Today's puzzles",
    "puzzles": "Puzzle solvers (all time)",
}


def _clock(sec: float) -> str:
    sec = int(round(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


@app.get("/api/leaderboards")
def leaderboard_list():
    cats = {k: v[0] for k, v in LEADERBOARDS.items()}
    cats["records"] = "Record holders (lowest energy per formula)"
    cats.update(PUZZLE_BOARDS)
    return cats


@app.get("/api/leaderboard/{category}")
def leaderboard(category: str, request: Request, limit: int = Query(20, ge=1, le=100)):
    limiter.hit("read:" + client_ip(request), READS_PER_IP_MIN, 60)
    if category != "records" and category not in LEADERBOARDS and category not in PUZZLE_BOARDS:
        raise HTTPException(404, f"Unknown leaderboard; try one of {list(leaderboard_list())}")

    def compute():
        con = db.connect()
        try:
            return _leaderboard(con, category, limit)
        finally:
            con.close()

    return read_cache.get(("lb", category, limit), compute)


def _leaderboard(con, category: str, limit: int):
    if category in PUZZLE_BOARDS:
        day_clause, args = ("AND day=?", (puzzles.today(),)) if category == "puzzle_daily" else ("", ())
        # Each puzzle counts once per player (free play and daily solves of the same
        # molecule are separate counted solves), with its fastest counted time.
        rows = con.execute(
            f"""SELECT p.nickname, COUNT(*) AS solved, SUM(a.seconds) AS seconds
                FROM (SELECT player_id, puzzle_id, MIN(solved_at - started_at) AS seconds
                      FROM puzzle_attempts WHERE counted=1 {day_clause} GROUP BY player_id, puzzle_id) a
                JOIN players p ON p.id=a.player_id GROUP BY p.id
                ORDER BY solved DESC, seconds ASC LIMIT ?""",
            (*args, limit),
        ).fetchall()
        return {"category": category, "title": PUZZLE_BOARDS[category],
                "rows": [{"rank": i + 1, "nickname": r["nickname"], "solved": r["solved"],
                          "seconds": round(r["seconds"], 1),
                          "value": f"{r['solved']} solved · {_clock(r['seconds'])}"} for i, r in enumerate(rows)]}
    elif category == "records":
        with db.write_lock(), con:
            mid = db.method_id(con, get_calculator())
        rows = con.execute(
            """WITH ranked AS (
                 SELECT player_id, formula,
                        ROW_NUMBER() OVER (PARTITION BY formula ORDER BY e_opt, id) AS rk
                 FROM submissions WHERE stable=1 AND method_id=?)
               SELECT p.nickname, COUNT(*) AS value FROM ranked r JOIN players p ON p.id=r.player_id
               WHERE rk=1 GROUP BY p.id ORDER BY value DESC, p.nickname LIMIT ?""",
            (mid, limit),
        ).fetchall()
        title = "Record holders (lowest energy per formula)"
    elif category in LEADERBOARDS:
        title, agg, where = LEADERBOARDS[category]
        rows = con.execute(
            f"""SELECT p.nickname, {agg} AS value FROM submissions s JOIN players p ON p.id=s.player_id
                WHERE 1=1 {where} GROUP BY p.id HAVING value > 0
                ORDER BY value DESC, MIN(s.id) LIMIT ?""",
            (limit,),
        ).fetchall()
    return {"category": category, "title": title,
            "rows": [{"rank": i + 1, "nickname": r["nickname"], "value": r["value"]} for i, r in enumerate(rows)]}


# ------------------------------------------------------------------ misc


@app.get("/api/health")
async def health():  # async: answers even while worker threads are busy
    calc = get_calculator()
    return {"ok": True, "version": __version__, "method": {"name": calc.name, "version": calc.version},
            "available_methods": available()}


@app.get("/api/stats")
def stats(request: Request):
    limiter.hit("read:" + client_ip(request), READS_PER_IP_MIN, 60)
    return read_cache.get(("stats",), _stats)


def _stats():
    con = db.connect()
    try:
        return _stats_query(con)
    finally:
        con.close()


def _stats_query(con):
    r = con.execute(
        """SELECT (SELECT COUNT(*) FROM players) AS players,
                  (SELECT COUNT(*) FROM submissions) AS submissions,
                  (SELECT COUNT(*) FROM geometries) AS geometries,
                  (SELECT COUNT(DISTINCT smiles) FROM submissions WHERE stable=1) AS molecules,
                  (SELECT COUNT(DISTINCT smiles) FROM submissions WHERE stable=1 AND in_pubchem=0) AS discoveries"""
    ).fetchone()
    return dict(r)


# The game itself (index.html, app.js, vendor/). Mounted last so /api routes win.
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
