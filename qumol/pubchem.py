"""PubChem lookups: is this molecule known, and if so, what is it called?

1. A local table built from the PubChem dump with scripts/build_pubchem_index.py
   (InChIKey -> CID -> title, molecules with at most 10 heavy atoms). Fast and offline.
   Location: QUMOL_PUBCHEM_DB, else pubchem.sqlite next to the game database.
2. PubChem's web API, used when there is no local table, and to double-check a
   local "not found" before awarding the discovery bonus (the dump may be older
   than PubChem). If that check fails, the result counts as unknown and no bonus is
   given. Results are cached in the game database.

Set QUMOL_PUBCHEM=0 to turn the web API off (tests, offline play); a local "not found"
is then trusted as is.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request

from . import db

URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/cids/JSON"
COMPOUND_URL = "https://pubchem.ncbi.nlm.nih.gov/compound/{cid}"

_local = {"path": None, "con": None}
_local_lock = threading.Lock()


def local_path() -> str:
    return os.environ.get("QUMOL_PUBCHEM_DB") or os.path.join(
        os.path.dirname(os.path.abspath(db.db_path())), "pubchem.sqlite")


def _local_con():
    path = local_path()
    if _local["path"] != path or (_local["con"] is None and os.path.exists(path)):
        if _local["con"] is not None:
            _local["con"].close()
        _local["path"], _local["con"] = path, None
        if os.path.exists(path):  # picked up as soon as the file is copied in, no restart needed
            _local["con"] = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    return _local["con"]


def lookup_local(inchikey: str | None):
    """(found, cid, title) from the local table; found is None if there is no table."""
    if not inchikey:
        return None, None, None
    with _local_lock:
        con = _local_con()
        if con is None:
            return None, None, None
        row = con.execute("SELECT cid, title FROM compounds WHERE inchikey=? ORDER BY cid LIMIT 1",
                          (inchikey,)).fetchone()
        if row is None:  # same connectivity with different stereochemistry still counts as known
            row = con.execute("SELECT cid, title FROM compounds WHERE key14=? ORDER BY cid LIMIT 1",
                              (inchikey[:14],)).fetchone()
    return (True, row[0], row[1]) if row else (False, None, None)


def lookup_live(smiles: str, timeout: float = 8.0) -> tuple[bool | None, list[int]]:
    """Return (in_pubchem, cids). in_pubchem is None if the check failed."""
    data = urllib.parse.urlencode({"smiles": smiles}).encode()
    req = urllib.request.Request(URL, data=data, headers={"User-Agent": "QuMol/0.3"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False, []
        try:
            body = json.load(e)
            if "NotFound" in body.get("Fault", {}).get("Code", ""):
                return False, []
        except Exception:
            pass
        return None, []
    except Exception:
        return None, []
    cids = [c for c in body.get("IdentifierList", {}).get("CID", []) if c > 0]
    return bool(cids), cids


def web_enabled() -> bool:
    return os.environ.get("QUMOL_PUBCHEM", "1") != "0"


def lookup_web(con, smiles: str | None) -> tuple[bool | None, int | None]:
    """(known, first cid) from the web API, cached in the game database."""
    if not smiles:
        return None, None
    row = con.execute("SELECT in_pubchem, cids_json FROM pubchem_cache WHERE smiles=?", (smiles,)).fetchone()
    if row:
        cids = json.loads(row["cids_json"] or "[]")
        return bool(row["in_pubchem"]), (cids[0] if cids else None)
    if not web_enabled():
        return None, None
    known, cids = lookup_live(smiles)
    if known is not None:
        with con:
            con.execute(
                "INSERT OR REPLACE INTO pubchem_cache(smiles, in_pubchem, cids_json) VALUES (?,?,?)",
                (smiles, int(known), json.dumps(cids[:20])),
            )
    return known, (cids[0] if cids else None)


def lookup(con, smiles: str | None, inchikey: str | None, use_web: bool = True) -> dict:
    """{'known': True/False/None, 'cid', 'name', 'url'}; known is None if nothing could be checked."""
    found, cid, title = lookup_local(inchikey)
    if found is False and use_web:
        # Confirm a local miss online before calling it new: the dump may be out of date.
        web, web_cid = lookup_web(con, smiles)
        if web:
            found, cid = True, web_cid
        elif web is None and web_enabled():
            found = None  # the online check failed: don't call it new without it
    elif found is None and use_web:
        found, cid = lookup_web(con, smiles)
    return {
        "known": found,
        "cid": cid,
        "name": title,
        "url": COMPOUND_URL.format(cid=int(cid)) if cid else None,
    }
