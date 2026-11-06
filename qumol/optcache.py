"""Reuse earlier optimizations.

Where an optimization ends up depends on where it starts, so results are keyed by the
starting 3D geometry: a HashMol3D hash of the raw submission on a coarse 0.1 Å grid, plus
the submitter's bonding (as SMILES, so charges and radicals count) and the energy method.
When another player submits the same start, the stored result and trajectory are mapped
onto their atom order and orientation instead of running the optimizer again.
"""

from __future__ import annotations

import json
import zlib

import numpy as np
from hashmol3d import hash_molecule

from .calculators import OptResult, subsample_idx
from .chem import ELEMENTS
from .puzzles import best_alignment

PRECISION = 0.1  # Å grid of the cache key
MAX_RMSD = 0.3  # Å; a stored start further than this from the new one is not reused
MAX_FRAMES = 400  # stored per trajectory (the score card and plots use at most this many)


def cache_key(mol) -> str | None:
    """HashMol3D identifier of the raw start on the 0.1 Å grid (None if it can't be hashed)."""
    try:
        numbers = [ELEMENTS[s]["z"] for s in mol.symbols]
        return hash_molecule(numbers, np.asarray(mol.coords, dtype=float), precision=PRECISION,
                             multiplicity=mol.multiplicity).hash_str
    except Exception:  # search budget exceeded, degenerate geometry, ...
        return None


def _r(a, nd=None):
    """Coordinates as lists. The start and the result keep full precision, since a rounded value
    could land in another cell of HashMol3D's 1e-4 Å grid and change the geometry ID."""
    a = np.asarray(a, dtype=float)
    return (a if nd is None else np.round(a, nd)).tolist()


def store(con, key: str, smiles: str, method_id: int, mol, res: OptResult, elapsed: float) -> None:
    """Save a result (call inside the database write lock). The first result for a key wins."""
    idx = subsample_idx(len(res.frames), MAX_FRAMES)
    aligned = len(res.frame_info) == len(res.frames)
    data = {
        "symbols": list(mol.symbols), "bonds": [list(b) for b in mol.bonds], "coords": _r(mol.coords),
        "e_input": res.e_input, "e_opt": res.e_opt, "fmax": res.fmax, "converged": bool(res.converged),
        "saddle": bool(res.saddle), "n_steps": int(res.n_steps), "prerelax_steps": int(res.prerelax_steps),
        "coords_input": _r(res.coords_input), "coords_opt": _r(res.coords_opt),
        "frames": [_r(res.frames[i], 4) for i in idx],
        "frame_info": [list(res.frame_info[i]) for i in idx] if aligned else [],
        "stages": res.stages, "elapsed": round(float(elapsed), 3),
    }
    con.execute("INSERT OR IGNORE INTO opt_cache(input_key, smiles, method_id, data) VALUES (?,?,?,?)",
                (key, smiles, method_id, zlib.compress(json.dumps(data, separators=(",", ":")).encode())))


def lookup(con, key: str, smiles: str, method_id: int, mol) -> tuple[OptResult, float] | None:
    """The stored result for this start, in the new molecule's atom order and frame, plus the
    original computing time; None if there is none or it doesn't map cleanly."""
    row = con.execute("SELECT data FROM opt_cache WHERE input_key=? AND smiles=? AND method_id=?",
                      (key, smiles, method_id)).fetchone()
    if row is None:
        return None
    try:
        d = json.loads(zlib.decompress(row[0]))
        ref = {"symbols": d["symbols"], "bonds": [tuple(b) for b in d["bonds"]], "coords": d["coords"]}
        rmsd, idx, R, pc, qc = best_alignment(ref, mol.symbols, mol.coords, mol.bonds)
    except (ValueError, KeyError, zlib.error):
        return None
    if rmsd > MAX_RMSD or len(idx) != len(mol.symbols):
        return None

    def place(X):
        """Stored coordinates (submitter's order and frame) -> the new molecule's."""
        X = np.asarray(X, dtype=float)
        out = np.empty_like(X)
        out[idx] = (X - qc) @ R + pc
        return out

    frames = [place(f) for f in d["frames"]]
    res = OptResult(
        e_input=d["e_input"], e_opt=d["e_opt"], coords_input=place(d["coords_input"]),
        coords_opt=place(d["coords_opt"]), fmax=d["fmax"], converged=d["converged"], saddle=d["saddle"],
        n_steps=d["n_steps"], frames=frames, prerelax_steps=d["prerelax_steps"],
        frame_info=[tuple(i) for i in d["frame_info"]], stages=d["stages"],
    )
    return res, float(d.get("elapsed", 0.0))


def count_hit(con, key: str, smiles: str, method_id: int) -> None:
    con.execute("UPDATE opt_cache SET hits = hits + 1 WHERE input_key=? AND smiles=? AND method_id=?",
                (key, smiles, method_id))
