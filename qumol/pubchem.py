"""PubChem novelty check, cached in the database.

Set QUMOL_PUBCHEM=0 to turn the live lookup off (for tests or offline play).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/cids/JSON"


def lookup_live(smiles: str, timeout: float = 8.0) -> tuple[bool | None, list[int]]:
    """Return (in_pubchem, cids). in_pubchem is None if the check failed."""
    data = urllib.parse.urlencode({"smiles": smiles}).encode()
    req = urllib.request.Request(URL, data=data, headers={"User-Agent": "QuMol/0.2"})
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


def in_pubchem(con, smiles: str | None) -> bool | None:
    if not smiles:
        return None
    row = con.execute("SELECT in_pubchem FROM pubchem_cache WHERE smiles=?", (smiles,)).fetchone()
    if row:
        return bool(row["in_pubchem"])
    if os.environ.get("QUMOL_PUBCHEM", "1") == "0":
        return None
    known, cids = lookup_live(smiles)
    if known is not None:
        with con:
            con.execute(
                "INSERT OR REPLACE INTO pubchem_cache(smiles, in_pubchem, cids_json) VALUES (?,?,?)",
                (smiles, int(known), json.dumps(cids[:20])),
            )
    return known
