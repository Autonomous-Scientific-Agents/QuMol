"""Submission pipeline: optimise, hash, store and score.

The server is authoritative: it recomputes energies itself, so scores cannot be
faked from the browser.
"""

from __future__ import annotations

import json
import math
import zlib
from contextlib import nullcontext

import numpy as np

from . import db, pubchem
from .calculators import get_calculator, subsample
from .chem import hash_geometry, inchikey_of, smiles_of, structure_intact, to_xyz, validate

# Point values, kept in one place so they are easy to tune.
POINTS = {
    "geometry_max": 100,
    "stable": 50,
    "hand_built": 50,
    "new_to_game": 100,
    "new_formula": 1000,  # 10x a new SMILES
    "formula_record": 300,
    "smiles_record": 100,
    "not_in_pubchem": 1000,
}
INPUT_METHODS = ("hand", "xyz", "smiles", "2d", "example")
GEOMETRY_SCORED = ("hand", "xyz")  # 2D and SMILES inputs get auto-generated geometry
NO_GEOMETRY_LABEL = {
    "example": "Example molecule: no geometry points",
    "smiles": "Auto-generated geometry: no geometry points",
    "2d": "Auto-generated geometry: no geometry points",
}


def size_multiplier(n_heavy: int) -> float:
    return 1.0 / math.sqrt(max(1, n_heavy))


def submit(con, player_id: int, symbols, coords, bonds, input_method: str = "hand",
           mode: str = "stable", method: str | None = None, compute=nullcontext) -> dict:
    """``compute`` is a context manager held only around the CPU-heavy part."""
    if input_method not in INPUT_METHODS:
        raise ValueError(f"input_method must be one of {INPUT_METHODS}")
    mol = validate(symbols, coords, bonds)
    calc = get_calculator(method)
    raw_xyz = to_xyz(mol.symbols, mol.coords, "raw submission")
    seed = zlib.crc32(raw_xyz.encode())

    with compute():
        res = calc.optimize(mol, seed=seed)
        stable = bool(res.converged and structure_intact(mol, res.coords_opt))
        g_in = hash_geometry(mol.symbols, res.coords_input)
        g_opt = hash_geometry(mol.symbols, res.coords_opt)
    smiles = smiles_of(mol)
    inchikey = inchikey_of(smiles)
    n_heavy = mol.n_heavy
    d_e_per_atom = max(0.0, res.e_input - res.e_opt) / len(mol.symbols)
    tol = calc.skill_scale * 0.005

    # Network lookup happens before taking the write lock.
    known = pubchem.in_pubchem(con, smiles) if (stable and smiles) else None

    lines: list[list] = []
    with db.write_lock(), con:
        mid = db.method_id(con, calc)
        db.upsert_geometry(con, g_in, n_heavy, to_xyz(g_in.std_symbols, g_in.std_coords, g_in.id), player_id)
        db.upsert_geometry(con, g_opt, n_heavy, to_xyz(g_opt.std_symbols, g_opt.std_coords, g_opt.id), player_id)
        db.add_calculation(con, g_in.id, mid, "single_point", energy=res.e_input)
        db.add_calculation(
            con, g_in.id, mid, "optimization", energy=res.e_opt, fmax=res.fmax, converged=res.converged,
            result_geometry_id=g_opt.id,
            extra={"stable": stable, "saddle": res.saddle, "n_steps": res.n_steps},
        )

        def scalar(sql, *args):
            row = con.execute(sql, args).fetchone()
            return row[0] if row else None

        already = bool(smiles) and scalar(
            "SELECT 1 FROM submissions WHERE player_id=? AND smiles=? AND stable=1 LIMIT 1", player_id, smiles
        ) is not None

        if already:
            lines.append(["Already in your collection", 0, smiles])
            lines.append(["Try something new for points!", 0, None])
        else:
            if input_method in GEOMETRY_SCORED:
                pts = round(POINTS["geometry_max"] * math.exp(-d_e_per_atom / calc.skill_scale))
                lines.append(["Geometry skill", pts, f"ΔE {d_e_per_atom:.3g} {calc.energy_unit} per atom"])
            else:
                lines.append([NO_GEOMETRY_LABEL[input_method], 0, None])
            if res.saddle:
                lines.append(["Started on a saddle point and rolled off!", 0, None])
            lines.append(["Stable structure" if stable else "Unstable: no bonuses", POINTS["stable"] if stable else 0, None])
            if input_method == "hand":
                lines.append(["Hand-built", POINTS["hand_built"], None])
            if stable and smiles:
                seen = scalar("SELECT 1 FROM submissions WHERE smiles=? AND stable=1 LIMIT 1", smiles)
                if seen is None:
                    lines.append(["New to QuMol", POINTS["new_to_game"], smiles])
                else:
                    best_s = scalar(
                        "SELECT MIN(e_opt) FROM submissions WHERE smiles=? AND method_id=? AND stable=1", smiles, mid
                    )
                    if best_s is not None and res.e_opt < best_s - tol:
                        lines.append(["Best geometry yet for this molecule", POINTS["smiles_record"], smiles])
                best_f = scalar(
                    "SELECT MIN(e_opt) FROM submissions WHERE formula=? AND method_id=? AND stable=1",
                    g_opt.formula, mid,
                )
                if best_f is None:
                    lines.append([f"New formula: {g_opt.formula}!", POINTS["new_formula"], None])
                elif res.e_opt < best_f - tol:
                    lines.append([f"New record for {g_opt.formula}!", POINTS["formula_record"], None])
                if known is False:
                    lines.append(["NOT IN PUBCHEM! 🤯", POINTS["not_in_pubchem"], None])
                elif known is True:
                    lines.append(["Known in PubChem", 0, None])
                else:
                    lines.append(["PubChem check unavailable", 0, None])
            elif stable and not smiles:
                lines.append(["Could not read the bonding as a molecule: no novelty bonus", 0, None])

        mult = size_multiplier(n_heavy)
        raw = sum(p for _, p, _ in lines)
        score = 0 if already else max(1, round(raw * mult))
        discovery = (known is False) and not already and stable

        cur = con.execute(
            """INSERT INTO submissions
               (player_id, method_id, input_method, mode, raw_xyz, bonds_json, input_geometry_id,
                optimized_geometry_id, smiles, inchikey, formula, n_heavy, e_input, e_opt, stable,
                saddle, in_pubchem, score, breakdown_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (player_id, mid, input_method, mode, raw_xyz, json.dumps(mol.bonds), g_in.id, g_opt.id,
             smiles, inchikey, g_opt.formula, n_heavy, res.e_input, res.e_opt, int(stable),
             int(res.saddle), None if known is None else int(known), score,
             json.dumps({"lines": lines, "multiplier": mult})),
        )
        sub_id = cur.lastrowid
        total = scalar("SELECT COALESCE(SUM(score),0) FROM submissions WHERE player_id=?", player_id)

    return {
        "submission_id": sub_id,
        "score": score,
        "total": total,
        "lines": lines,
        "multiplier": round(mult, 4),
        "n_heavy": n_heavy,
        "stable": stable,
        "saddle": res.saddle,
        "already": already,
        "discovery": discovery,
        "smiles": smiles,
        "formula": g_opt.formula,
        "input_geometry_id": g_in.id,
        "optimized_geometry_id": g_opt.id,
        "method": {"name": calc.name, "version": calc.version, "energy_unit": calc.energy_unit},
        "energies": {"input": res.e_input, "optimized": res.e_opt},
        "frames": [np.round(f, 3).tolist() for f in subsample(res.frames)],
        "coords_opt": np.round(res.coords_opt, 4).tolist(),
    }
