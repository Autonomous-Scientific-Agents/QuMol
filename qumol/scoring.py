"""Submission pipeline: optimize, hash, store and score.

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
    "formal_charges": 50,  # small bonus for zwitterionic bonding like ⁻C≡O⁺
}
INPUT_METHODS = ("hand", "xyz", "smiles", "2d", "example")
GEOMETRY_SCORED = ("hand", "xyz")  # 2D and SMILES inputs get auto-generated geometry
NO_GEOMETRY_NOTE = {
    "example": "example molecule",
    "smiles": "auto-generated geometry",
    "2d": "auto-generated geometry",
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
        g_in = hash_geometry(mol.symbols, res.coords_input, multiplicity=mol.multiplicity)
        g_opt = hash_geometry(mol.symbols, res.coords_opt, multiplicity=mol.multiplicity)
    smiles = smiles_of(mol)
    inchikey = inchikey_of(smiles)
    n_heavy = mol.n_heavy
    d_e_per_atom = max(0.0, res.e_input - res.e_opt) / len(mol.symbols)
    tol = calc.skill_scale * 0.005

    # Lookups happen before taking the write lock. The web API is only asked about
    # stable structures (it can award the discovery bonus); the local table always.
    pc = pubchem.lookup(con, smiles, inchikey, use_web=stable) if smiles else \
        {"known": None, "cid": None, "name": None, "url": None}
    known = pc["known"]

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

        def pubchem_line(points):
            if known is True:
                name = pc["name"] or (f"CID {pc['cid']}" if pc["cid"] else "known compound")
                detail = f"{name} · CID {pc['cid']}" if pc["name"] and pc["cid"] else name
                return ["In PubChem", 0, detail, pc["url"]]
            if known is False:
                return ["Not in PubChem", points, "possibly new to science", None]
            return ["PubChem", 0, "check unavailable", None]

        if already:
            lines.append(["Already collected", 0, smiles])
            if smiles:
                lines.append(pubchem_line(0))
        else:
            if input_method in GEOMETRY_SCORED:
                pts = round(POINTS["geometry_max"] * math.exp(-d_e_per_atom / calc.skill_scale))
                lines.append(["Geometry", pts, f"ΔE {d_e_per_atom:.3g} {calc.energy_unit} per atom"])
            else:
                lines.append(["Geometry", 0, NO_GEOMETRY_NOTE[input_method]])
            if res.saddle:
                lines.append(["Saddle point", 0, "rolled off to a minimum"])
            lines.append(["Stable", POINTS["stable"], None] if stable else ["Unstable", 0, "no bonuses"])
            if mol.radicals:
                n = mol.radicals
                lines.append(["Radical", 0, f"{n} unpaired electron{'s' if n > 1 else ''}"])
            if stable and any(mol.charges or []):
                lines.append(["Formal charges", POINTS["formal_charges"], None])
            if input_method == "hand":
                lines.append(["Hand-built", POINTS["hand_built"], None])
            if stable and smiles:
                seen = scalar("SELECT 1 FROM submissions WHERE smiles=? AND stable=1 LIMIT 1", smiles)
                if seen is None:
                    lines.append(["New SMILES", POINTS["new_to_game"], smiles])
                else:
                    best_s = scalar(
                        "SELECT MIN(e_opt) FROM submissions WHERE smiles=? AND method_id=? AND stable=1", smiles, mid
                    )
                    if best_s is not None and res.e_opt < best_s - tol:
                        lines.append(["SMILES record", POINTS["smiles_record"], "lowest energy yet for this molecule"])
                best_f = scalar(
                    "SELECT MIN(e_opt) FROM submissions WHERE formula=? AND method_id=? AND stable=1",
                    g_opt.formula, mid,
                )
                if best_f is None:
                    lines.append(["New formula", POINTS["new_formula"], g_opt.formula])
                elif res.e_opt < best_f - tol:
                    lines.append(["Formula record", POINTS["formula_record"], f"lowest energy yet for {g_opt.formula}"])
                lines.append(pubchem_line(POINTS["not_in_pubchem"]))
            elif stable and not smiles:
                lines.append(["New SMILES", 0, "couldn't read the bonding"])
            elif smiles:
                lines.append(pubchem_line(0))

        mult = size_multiplier(n_heavy)
        raw = sum(line[1] for line in lines)
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
        "pubchem": pc,
        "input_geometry_id": g_in.id,
        "optimized_geometry_id": g_opt.id,
        "method": {"name": calc.name, "version": calc.version, "energy_unit": calc.energy_unit},
        "energies": {"input": res.e_input, "optimized": res.e_opt},
        "frames": [np.round(f, 3).tolist() for f in subsample(res.frames)],
        "coords_opt": np.round(res.coords_opt, 4).tolist(),
    }
