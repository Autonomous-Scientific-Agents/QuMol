"""Submission pipeline: optimize, hash, store and score.

The server is authoritative: it recomputes energies itself, so scores cannot be
faked from the browser.
"""

from __future__ import annotations

import json
import math
import time
import zlib
from contextlib import nullcontext

import numpy as np

from . import db, pubchem
from .calculators import get_calculator, subsample_idx
from .chem import hash_geometry, inchikey_of, smiles_of, structure_problem, to_xyz, validate

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


def size_bonus(n_atoms: int) -> int:
    """Smaller molecules are harder to find new: 1000 points for 2 atoms (hydrogens count),
    50 fewer for each extra atom, nothing from 22 atoms up."""
    return max(0, 1000 - 50 * (max(2, n_atoms) - 2))


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
        t0 = time.perf_counter()
        res = calc.optimize(mol, seed=seed)
        elapsed = time.perf_counter() - t0
        problem = structure_problem(mol, res.coords_opt)
        intact = problem is None
        stable = bool(res.converged and intact)
        g_in = hash_geometry(mol.symbols, res.coords_input, multiplicity=mol.multiplicity)
        g_opt = hash_geometry(mol.symbols, res.coords_opt, multiplicity=mol.multiplicity)
    # Tell the player what went wrong instead of silently showing a broken structure:
    # which bond broke, and at which step of which stage it first happened.
    events = []
    for st in res.stages:
        if st.get("used") is False:
            events.append(f"{st['name']}: skipped, it broke the structure")
        elif st["name"] == "saddle check":
            events.append("saddle check: a small kick lowered the energy, so it rolled off a saddle point"
                          if st.get("saddle") else "saddle check: still a minimum after a small kick")
        else:
            events.append(f"{st['name']}: {st['steps']} steps, energy {st['e_start']:.4f} → {st['e_end']:.4f} "
                          f"{st['unit']}{'' if st['converged'] else ' (step limit reached, not converged)'}")
    if not intact:
        first = next((i for i, f in enumerate(res.frames) if structure_problem(mol, f)), None)
        where = ""
        if first is not None and first < len(res.frame_info):
            stage, step, _, _ = res.frame_info[first]
            where = f" ({stage}, step {step})"
        events.append(f"failed: {problem}{where}")
    if not intact:
        opt_status, warning = "broken", (
            "The optimizer pulled the structure apart: bonds stretched or atoms collided. "
            "Your structure may be too far from a stable minimum. Try more reasonable bond "
            "lengths and angles (📏 Measure helps).")
    elif not res.converged:
        opt_status, warning = "not_converged", (
            "The optimization didn't converge, so the structure may still be far from a minimum.")
    else:
        opt_status, warning = "ok", None
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
            extra={"stable": stable, "saddle": res.saddle, "n_steps": res.n_steps,
                   "prerelax_steps": res.prerelax_steps, "intact": intact},
        )

        def scalar(sql, *args):
            row = con.execute(sql, args).fetchone()
            return row[0] if row else None

        already = bool(smiles) and scalar(
            "SELECT 1 FROM submissions WHERE player_id=? AND smiles=? AND stable=1 LIMIT 1", player_id, smiles
        ) is not None

        # Points need a stable molecule QuMol can identify by SMILES: "Already collected" is
        # keyed on the SMILES of stable submissions, so anything else could be resubmitted
        # for the same points again and again.
        scorable = stable and bool(smiles)
        # Only real chemical species earn the discovery and size bonuses: stable minima, and
        # later verified transition states (needs a frequency check: exactly one imaginary mode).
        transition_state = False
        bonus_ok = scorable or transition_state

        # Order on the score card: discoveries first, then quality, then bonuses. Whether the
        # compound is in PubChem is shown in the card header (name and link), not as a line,
        # unless it earns the discovery bonus.
        if already:
            lines.append(["Already collected", 0, None])
        else:
            if stable and smiles:
                # Novelty is across all methods (switching potentials doesn't make a formula new
                # again); records compare energies within one method.
                seen_f = scalar("SELECT 1 FROM submissions WHERE formula=? AND stable=1 LIMIT 1", g_opt.formula)
                best_f = scalar(
                    "SELECT MIN(e_opt) FROM submissions WHERE formula=? AND method_id=? AND stable=1",
                    g_opt.formula, mid,
                )
                if seen_f is None:
                    lines.append(["New QuMol formula", POINTS["new_formula"], None])
                elif best_f is not None and res.e_opt < best_f - tol:
                    lines.append(["Formula record", POINTS["formula_record"], "lowest energy yet for this formula"])
                seen = scalar("SELECT 1 FROM submissions WHERE smiles=? AND stable=1 LIMIT 1", smiles)
                if seen is None:
                    lines.append(["New QuMol SMILES", POINTS["new_to_game"], None])
                else:
                    best_s = scalar(
                        "SELECT MIN(e_opt) FROM submissions WHERE smiles=? AND method_id=? AND stable=1", smiles, mid
                    )
                    if best_s is not None and res.e_opt < best_s - tol:
                        lines.append(["SMILES record", POINTS["smiles_record"], "lowest energy yet for this molecule"])
            elif stable and not smiles:
                lines.append(["New QuMol SMILES", 0, "couldn't read the bonding"])
            if scorable:
                lines.append(["Stable", POINTS["stable"], None])
            elif stable:
                lines.append(["Stable", 0, "no points without a readable SMILES"])
            elif opt_status == "broken":
                lines.append(["Optimization failed", 0, "structure fell apart; no bonuses"])
            elif opt_status == "not_converged":
                lines.append(["Not converged", 0, "no bonuses"])
            else:
                lines.append(["Unstable", 0, "no bonuses"])
            if input_method == "hand":
                lines.append(["Hand-built", POINTS["hand_built"] if scorable else 0, None])
            if input_method in GEOMETRY_SCORED:
                pts = round(POINTS["geometry_max"] * math.exp(-d_e_per_atom / calc.skill_scale)) if scorable else 0
                lines.append(["Geometry", pts, f"ΔE {d_e_per_atom:.3g} {calc.energy_unit} per atom"])
            else:
                lines.append(["Geometry", 0, NO_GEOMETRY_NOTE[input_method]])
            if res.saddle:
                lines.append(["Saddle point", 0, "rolled off to a minimum"])
            if mol.radicals:
                n = mol.radicals
                lines.append(["Radical", 0, f"{n} unpaired electron{'s' if n > 1 else ''}"])
            if scorable and any(mol.charges or []):
                lines.append(["Formal charges", POINTS["formal_charges"], None])
            if bonus_ok and smiles and known is False:
                lines.append(["Not in PubChem", POINTS["not_in_pubchem"], "possibly new to science"])
            if bonus_ok:
                n_atoms = len(mol.symbols)
                lines.append(["Size bonus", size_bonus(n_atoms), f"{n_atoms} atoms: smaller scores more"])

        score = 0 if already else sum(line[1] for line in lines)
        discovery = (known is False) and not already and bonus_ok

        cur = con.execute(
            """INSERT INTO submissions
               (player_id, method_id, input_method, mode, raw_xyz, bonds_json, input_geometry_id,
                optimized_geometry_id, smiles, inchikey, formula, n_heavy, e_input, e_opt, stable,
                saddle, in_pubchem, score, breakdown_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (player_id, mid, input_method, mode, raw_xyz, json.dumps(mol.bonds), g_in.id, g_opt.id,
             smiles, inchikey, g_opt.formula, n_heavy, res.e_input, res.e_opt, int(stable),
             int(res.saddle), None if known is None else int(known), score,
             json.dumps({"lines": lines})),
        )
        sub_id = cur.lastrowid
        total = scalar("SELECT COALESCE(SUM(score),0) FROM submissions WHERE player_id=?", player_id)

    idx = subsample_idx(len(res.frames))
    return {
        "submission_id": sub_id,
        "score": score,
        "total": total,
        "lines": lines,
        "n_heavy": n_heavy,
        "stable": stable,
        "opt_status": opt_status,
        "warning": warning,
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
        "frames": [np.round(res.frames[i], 3).tolist() for i in idx],
        # Per frame: [stage, step, energy, max force], for the readout during the movie.
        "frame_info": [list(res.frame_info[i]) for i in idx] if len(res.frame_info) == len(res.frames) else [],
        "log": {
            "method": f"{calc.name} {calc.version}",
            "elapsed_s": round(elapsed, 2),
            "events": events,
            "steps": [[st, n, round(e, 5), round(f, 4)] for st, n, e, f in
                      (res.frame_info[i] for i in subsample_idx(len(res.frame_info), 400))],
        },
        "coords_opt": np.round(res.coords_opt, 4).tolist(),
    }
