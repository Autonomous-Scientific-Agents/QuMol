"""QuMol web server: JSON API plus the game page.

Run:  uvicorn qumol.app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import hashlib
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, db, scoring
from .calculators import available, get_calculator
from .chem import ChemError

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
NICK_RE = re.compile(r"^[A-Za-z0-9_\-. ]{2,24}$")

@asynccontextmanager
async def lifespan(_app):
    db.init()
    yield


app = FastAPI(title="QuMol", version=__version__, lifespan=lifespan)


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
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing token")
    row = con.execute(
        "SELECT id, nickname FROM players WHERE token_hash=?", (_hash(authorization[7:].strip()),)
    ).fetchone()
    if not row:
        raise HTTPException(401, "Unknown token")
    return dict(row)


# ------------------------------------------------------------------ players


class NewPlayer(BaseModel):
    nickname: str


class Recover(BaseModel):
    nickname: str
    recovery_code: str


@app.post("/api/players")
def create_player(body: NewPlayer, con=Depends(get_con)):
    nick = body.nickname.strip()
    if not NICK_RE.match(nick):
        raise HTTPException(400, "Nickname: 2–24 letters, numbers, spaces, _ - or .")
    token, code = secrets.token_urlsafe(32), _recovery_code()
    try:
        with con:
            cur = con.execute(
                "INSERT INTO players(nickname, token_hash, recovery_hash) VALUES (?,?,?)",
                (nick, _hash(token), _hash(code)),
            )
    except Exception:
        raise HTTPException(409, "That nickname is taken")
    return {"player_id": cur.lastrowid, "nickname": nick, "token": token, "recovery_code": code}


@app.post("/api/players/recover")
def recover(body: Recover, con=Depends(get_con)):
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
    return {**player, **dict(r)}


# ------------------------------------------------------------------ submissions


class Atom(BaseModel):
    el: str
    x: float
    y: float
    z: float


class Submission(BaseModel):
    atoms: list[Atom] = Field(..., min_length=1, max_length=200)
    bonds: list[tuple[int, int, int]] = Field(default_factory=list, max_length=400)
    input_method: str = "hand"
    mode: str = "stable"


@app.post("/api/submissions")
def create_submission(body: Submission, player=Depends(current_player), con=Depends(get_con)):
    try:
        return scoring.submit(
            con, player["id"], [a.el for a in body.atoms], [[a.x, a.y, a.z] for a in body.atoms],
            body.bonds, body.input_method, body.mode,
        )
    except (ChemError, ValueError) as e:
        raise HTTPException(400, str(e))


@app.get("/api/submissions/mine")
def my_submissions(limit: int = Query(50, le=500), player=Depends(current_player), con=Depends(get_con)):
    rows = con.execute(
        """SELECT id, formula, smiles, score, stable, in_pubchem, input_method, created_at
           FROM submissions WHERE player_id=? ORDER BY id DESC LIMIT ?""",
        (player["id"], limit),
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/geometries/{gid}.xyz", response_class=PlainTextResponse)
def geometry_xyz(gid: str, con=Depends(get_con)):
    row = con.execute("SELECT xyz FROM geometries WHERE id=?", (gid,)).fetchone()
    if not row:
        raise HTTPException(404, "No such geometry")
    return row["xyz"]


# ------------------------------------------------------------------ leaderboards

LEADERBOARDS = {
    "overall": ("Top scorers", "SUM(s.score)", ""),
    "hand": ("Hand builders", "SUM(s.score)", "AND s.input_method='hand'"),
    "xyz": ("XYZ submitters", "SUM(s.score)", "AND s.input_method='xyz'"),
    "weekly": ("This week", "SUM(s.score)", "AND s.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    "small": ("Small-molecule masters (≤ 8 heavy atoms)", "SUM(s.score)", "AND s.n_heavy <= 8"),
    "discoveries": ("Discoverers (not in PubChem)", "COUNT(DISTINCT s.smiles)", "AND s.stable=1 AND s.in_pubchem=0"),
    "molecules": ("Collectors (distinct molecules)", "COUNT(DISTINCT s.smiles)", "AND s.stable=1"),
}


@app.get("/api/leaderboards")
def leaderboard_list():
    cats = {k: v[0] for k, v in LEADERBOARDS.items()}
    cats["records"] = "Record holders (lowest energy per formula)"
    return cats


@app.get("/api/leaderboard/{category}")
def leaderboard(category: str, limit: int = Query(20, le=100), con=Depends(get_con)):
    if category == "records":
        mid = db.method_id(con, get_calculator())
        con.commit()
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
    else:
        raise HTTPException(404, f"Unknown leaderboard; try one of {list(leaderboard_list())}")
    return {"category": category, "title": title,
            "rows": [{"rank": i + 1, "nickname": r["nickname"], "value": r["value"]} for i, r in enumerate(rows)]}


# ------------------------------------------------------------------ misc


@app.get("/api/health")
def health():
    calc = get_calculator()
    return {"ok": True, "version": __version__, "method": {"name": calc.name, "version": calc.version},
            "available_methods": available()}


@app.get("/api/stats")
def stats(con=Depends(get_con)):
    r = con.execute(
        """SELECT (SELECT COUNT(*) FROM players) AS players,
                  (SELECT COUNT(*) FROM submissions) AS submissions,
                  (SELECT COUNT(*) FROM geometries) AS geometries,
                  (SELECT COUNT(DISTINCT smiles) FROM submissions WHERE stable=1) AS molecules,
                  (SELECT COUNT(DISTINCT smiles) FROM submissions WHERE stable=1 AND in_pubchem=0) AS discoveries"""
    ).fetchone()
    return dict(r)


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


if WEB_DIR.exists():
    app.mount("/web", StaticFiles(directory=WEB_DIR), name="web")
