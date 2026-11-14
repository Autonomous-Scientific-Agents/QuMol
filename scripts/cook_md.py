"""Cooking-mode feasibility test: scatter bare atoms in a spherical beaker, heat, hold, cool.

Runs Langevin molecular dynamics with an ASE energy method (UMA by default) inside a
soft spherical wall, then quenches and reports the molecules that formed, plus the time
per model call, to see whether a cook fits in a game-sized time budget.

    .venv/bin/python scripts/cook_md.py C4N1O1 --temp 2000
    .venv/bin/python scripts/cook_md.py C4O2 --temp 1500 --method emt     # quick smoke test
    .venv/bin/python scripts/cook_md.py C4N1O1 --temp 2000 --xyz cook.xyz  # save trajectory

Schedule: ramp 300 K -> T over --heat ps, hold T for --hold ps, ramp T -> 300 K over --cool ps,
then a BFGS quench. Total spin is the lowest one the electron count allows (singlet or doublet).
Then the largest fragment gets bond orders from its bond lengths, H on every free valence
(like the game's H+), and QuMol's usual optimization and stability check.
For many runs with one model load, see scripts/cook_sweep.py.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from collections import Counter

sys.path.insert(0, __file__.rsplit("/scripts/", 1)[0])

import numpy as np  # noqa: E402
from ase import Atoms, units  # noqa: E402
from ase.calculators.calculator import Calculator, all_changes  # noqa: E402
from ase.md.langevin import Langevin  # noqa: E402
from ase.md.velocitydistribution import MaxwellBoltzmannDistribution  # noqa: E402
from ase.neighborlist import natural_cutoffs, neighbor_list  # noqa: E402
from ase.io import write  # noqa: E402
from ase.optimize import BFGS  # noqa: E402

from qumol.chem import hill_formula  # noqa: E402


class Beaker(Calculator):
    """Base calculator plus a harmonic wall that pushes atoms back inside radius R."""

    implemented_properties = ["energy", "forces"]

    def __init__(self, base, radius: float, k: float = 5.0):  # k in eV/Å²
        super().__init__()
        self.base, self.radius, self.k = base, radius, k
        self.n_calls, self.t_model = 0, 0.0

    def calculate(self, atoms=None, properties=("energy",), system_changes=all_changes):
        super().calculate(atoms, properties, system_changes)
        a = self.atoms.copy()  # keeps info (charge, spin) for UMA
        a.calc = self.base
        t = time.perf_counter()
        e = a.get_potential_energy()
        f = a.get_forces().copy()
        self.t_model += time.perf_counter() - t
        self.n_calls += 1
        x = self.atoms.get_positions() - self.atoms.get_center_of_mass()
        r = np.linalg.norm(x, axis=1) + 1e-12
        out = r > self.radius
        if out.any():
            d = r[out] - self.radius
            e += 0.5 * self.k * np.sum(d * d)
            f[out] -= (self.k * d / r[out])[:, None] * x[out]
        self.results = {"energy": e, "forces": f}


def parse_recipe(text: str) -> list[str]:
    syms = []
    for el, n in re.findall(r"([A-Z][a-z]?)(\d*)", text):
        syms += [el] * (int(n) if n else 1)
    if not syms:
        raise SystemExit(f"Could not read the recipe {text!r}; write it like C3N1O1H6")
    return syms


def scatter(symbols, radius, min_dist, rng):
    pos = []
    for _ in symbols:
        for _try in range(10000):
            p = rng.uniform(-radius, radius, 3)
            if np.linalg.norm(p) <= radius and all(np.linalg.norm(p - q) >= min_dist for q in pos):
                pos.append(p)
                break
        else:
            raise SystemExit("Beaker too small for these atoms; raise --radius or lower --min-dist")
    return np.array(pos)


def fragments(atoms, scale=1.2):
    """Connected components from distances (covalent radii x scale)."""
    n = len(atoms)
    i, j = neighbor_list("ij", atoms, [c * scale for c in natural_cutoffs(atoms)])
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in zip(i, j):
        parent[find(a)] = find(b)
    groups = {}
    for a in range(n):
        groups.setdefault(find(a), []).append(a)
    return sorted(groups.values(), key=len, reverse=True)


def smiles(atoms, idx):
    """SMILES from 3D with RDKit's bond-order perception; None if it can't assign one."""
    from rdkit import Chem, RDLogger
    from rdkit.Chem import rdDetermineBonds

    RDLogger.DisableLog("rdApp.*")
    sub = atoms[idx]
    if len(sub) == 1:
        return f"[{sub.get_chemical_symbols()[0]}]"
    xyz = f"{len(sub)}\n\n" + "\n".join(f"{s} {x:.4f} {y:.4f} {z:.4f}"
                                        for s, (x, y, z) in zip(sub.get_chemical_symbols(), sub.positions))
    try:
        m = Chem.MolFromXYZBlock(xyz)
        rdDetermineBonds.DetermineBonds(m, charge=0)
        return Chem.MolToSmiles(Chem.RemoveHs(m))
    except Exception:
        pass
    try:  # radicals have no closed-shell bond orders: show the skeleton (single bonds only)
        m = Chem.MolFromXYZBlock(xyz)
        rdDetermineBonds.DetermineConnectivity(m)
        for a in m.GetAtoms():
            a.SetNoImplicit(True)
        return Chem.MolToSmiles(m, allHsExplicit=True) + "  (radical; skeleton only)"
    except Exception:
        return None


def summary(atoms):
    syms = atoms.get_chemical_symbols()
    return Counter(hill_formula([syms[k] for k in g]) for g in fragments(atoms))


def fmt(counter):
    return " + ".join(f"{n}×{f}" if n > 1 else f for f, n in counter.most_common())


def make_base(method: str):
    if method == "emt":
        from ase.calculators.emt import EMT

        return EMT()
    if method == "uma":
        from fairchem.core import FAIRChemCalculator, pretrained_mlip

        model = os.environ.get("QUMOL_UMA_MODEL", "uma-s-1p2p1")
        device = os.environ.get("QUMOL_DEVICE", "cpu")
        settings = os.environ.get("QUMOL_UMA_SETTINGS", "default")
        predictor = pretrained_mlip.get_predict_unit(model, inference_settings=settings, device=device)
        return FAIRChemCalculator(predictor, task_name="omol")
    if method in ANI:
        # MIT-licensed. No charge or spin input: every structure is treated as closed shell.
        os.environ.setdefault("TORCHANI_NO_WARN_EXTENSIONS", "1")
        import torchani

        return getattr(torchani.models, ANI[method])().ase()
    if method == "xtb":
        # GFN2-xTB through tblite (LGPL-3). Don't import torch in the same process: both ship
        # an OpenMP runtime and the second one aborts.
        return XTB()
    raise SystemExit(f"Unknown method {method!r}: use uma, xtb, {', '.join(ANI)} or emt")


ANI = {"ani2x": "ANI2x", "ani2xr": "ANI2xr", "ani2dr": "ANI2dr", "ani1xnr": "ANI1xnr"}


class XTB(Calculator):
    """GFN2-xTB that reads the spin multiplicity from atoms.info["spin"] like UMA does."""

    implemented_properties = ["energy", "forces"]

    def calculate(self, atoms=None, properties=("energy",), system_changes=all_changes):
        from tblite.ase import TBLite

        super().calculate(atoms, properties, system_changes)
        a = self.atoms.copy()
        a.calc = TBLite(method="GFN2-xTB", charge=0, multiplicity=int(a.info.get("spin", 1)), verbosity=0,
                        electronic_temperature=float(os.environ.get("COOK_XTB_ETEMP", 300)))
        self.results = {"energy": a.get_potential_energy(), "forces": a.get_forces().copy()}


def cook(base, symbols, temp=2000.0, heat=0.1, hold=0.3, cool=0.1, dt=None, friction=0.05, radius=None,
         min_dist=2.0, seed=0, report=None, xyz=None, log=print):
    """Scatter, heat, hold, cool and quench. Returns (atoms, stats)."""
    n = len(symbols)
    dt = dt or (0.5 if "H" in symbols else 1.0)
    # About 12 Å³ per atom by default: a dense gas, so atoms meet within a few hundred fs.
    radius = radius or max(3.0, (3 * 12.0 * n / (4 * np.pi)) ** (1 / 3))
    rng = np.random.default_rng(seed)
    atoms = Atoms(symbols, positions=scatter(symbols, radius, min_dist, rng))
    atoms.info.update({"charge": 0, "spin": 1 if sum(atoms.numbers) % 2 == 0 else 2})
    pot = Beaker(base, radius)
    atoms.calc = pot

    steps = {"heat": int(round(heat * 1000 / dt)), "hold": int(round(hold * 1000 / dt)),
             "cool": int(round(cool * 1000 / dt))}
    total = sum(steps.values())

    def temp_at(k):
        if k < steps["heat"]:
            return 300 + (temp - 300) * k / max(1, steps["heat"])
        if k < steps["heat"] + steps["hold"]:
            return temp
        return temp + (300 - temp) * (k - steps["heat"] - steps["hold"]) / max(1, steps["cool"])

    MaxwellBoltzmannDistribution(atoms, temperature_K=300, rng=rng)
    dyn = Langevin(atoms, dt * units.fs, temperature_K=300, friction=friction / units.fs, fixcm=False,
                   rng=np.random.default_rng(seed + 1))
    writer = open(xyz, "w") if xyz else None
    report_every = max(1, int(round(report * 1000 / dt))) if report else 0
    t_md = time.perf_counter()
    first_bond, t_max = None, 0.0
    for k in range(total):
        dyn.set_temperature(temperature_K=temp_at(k))
        dyn.run(1)
        t_max = max(t_max, atoms.get_temperature())
        if first_bond is None and len(fragments(atoms)) < n:
            first_bond = (k + 1) * dt
        if writer and k % 10 == 0:
            write(writer, atoms, format="extxyz")
        if report_every and ((k + 1) % report_every == 0 or k == total - 1):
            log(f"  t={(k + 1) * dt / 1000:5.2f} ps  T_set={temp_at(k):5.0f} K  "
                f"T_kin={atoms.get_temperature():5.0f} K  E={atoms.get_potential_energy():11.3f} eV  "
                f"{fmt(summary(atoms))}")
    t_md = time.perf_counter() - t_md
    md_calls, md_model = pot.n_calls, pot.t_model
    opt = BFGS(atoms, logfile=None, maxstep=0.2)
    quenched = opt.run(fmax=0.05, steps=300)
    if writer:
        write(writer, atoms, format="extxyz")
        writer.close()
    return atoms, {"radius": radius, "dt": dt, "steps": total, "t_md": t_md, "first_bond_fs": first_bond,
                   "ms_per_call": 1000 * md_model / max(1, md_calls), "quench_steps": opt.nsteps,
                   "quenched": bool(quenched), "t_kin_max": t_max}


# Bond length / (sum of covalent radii) below which a bond is read as triple or double.
TRIPLE, DOUBLE = 0.82, 0.91


def saturate(atoms, idx):
    """Bond orders from the cooked bond lengths, then H on every free valence (like H+).

    Returns (symbols, coords, bonds) ready for qumol.chem.validate."""
    from qumol.chem import ELEMENTS, assign_charges, max_bonds

    sub = atoms[idx]
    syms = sub.get_chemical_symbols()
    x = sub.get_positions()
    r = [ELEMENTS[s]["r"] for s in syms]
    n = len(syms)
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            d = np.linalg.norm(x[i] - x[j])
            if d < 1.2 * (r[i] + r[j]):
                pairs.append((d / (r[i] + r[j]), i, j))
    pairs.sort()  # shortest (relative) first
    cap = [max_bonds(s) for s in syms]
    used = [0] * n
    bonds = []
    for ratio, i, j in pairs:  # every bond gets order 1 first, shortest bonds win if crowded
        if used[i] < cap[i] and used[j] < cap[j]:
            bonds.append([i, j, 1])
            used[i] += 1
            used[j] += 1
    for b in bonds:  # then upgrade short bonds while both atoms have valence to spare
        i, j = b[0], b[1]
        ratio = np.linalg.norm(x[i] - x[j]) / (r[i] + r[j])
        want = 3 if ratio < TRIPLE else 2 if ratio < DOUBLE else 1
        val = [ELEMENTS[syms[k]]["val"] for k in (i, j)]
        while b[2] < want and used[i] < val[0] and used[j] < val[1]:
            b[2] += 1
            used[i] += 1
            used[j] += 1
    _, deficit = assign_charges(syms, [tuple(b) for b in bonds])
    syms, x = list(syms), [p for p in x]
    rng = np.random.default_rng(0)
    for i in range(n):
        for _ in range(max(0, deficit[i])):
            nb = [x[b[1] if b[0] == i else b[0]] - x[i] for b in bonds if i in b[:2]]
            best, gap = None, -1.0
            for _try in range(200):  # the direction farthest from everything already there
                d = rng.normal(size=3)
                d /= np.linalg.norm(d)
                if nb and np.dot(d, sum(v / np.linalg.norm(v) for v in nb)) > 0:
                    continue
                p = x[i] + d * (ELEMENTS[syms[i]]["r"] + ELEMENTS["H"]["r"]) * 1.05
                g = min((np.linalg.norm(p - q) for k, q in enumerate(x) if k != i), default=9.9)
                if g > gap:
                    best, gap = p, g
            x.append(best)
            syms.append("H")
            bonds.append([i, len(syms) - 1, 1])
    return syms, np.array(x), [tuple(b) for b in bonds]


def finish(qcalc, atoms, idx):
    """Saturate a cooked fragment and run it through QuMol's normal optimize + checks."""
    from qumol.chem import ChemError, smiles_of, structure_problem, validate

    syms, x, bonds = saturate(atoms, idx)
    try:
        mol = validate(syms, x, bonds)
    except ChemError as e:
        return {"formula": hill_formula(syms), "error": str(e)}
    t = time.perf_counter()
    res = qcalc.optimize(mol)
    problem = structure_problem(mol, res.coords_opt)
    return {"formula": hill_formula(syms), "smiles": smiles_of(mol), "converged": res.converged,
            "saddle": res.saddle, "stable": res.converged and not res.saddle and problem is None,
            "problem": problem, "t_opt": time.perf_counter() - t, "e_opt": res.e_opt}


def qumol_calculator(base, method):
    """QuMol's optimizer pipeline (toy-FF prerelax, BFGS, saddle check) on the already-loaded model."""
    from qumol.calculators.ase_calc import ASECalculator

    return ASECalculator(method, "cook-test", lambda: base)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recipe", help="atoms to put in the pot, e.g. C4N1O1")
    ap.add_argument("--temp", type=float, default=2000.0, help="hold temperature in K")
    ap.add_argument("--heat", type=float, default=0.1, help="ramp-up time in ps")
    ap.add_argument("--hold", type=float, default=0.3, help="time at --temp in ps")
    ap.add_argument("--cool", type=float, default=0.1, help="ramp-down time in ps")
    ap.add_argument("--dt", type=float, default=None, help="time step in fs (default 0.5 with H, 1.0 without)")
    ap.add_argument("--friction", type=float, default=0.05, help="Langevin friction in 1/fs")
    ap.add_argument("--radius", type=float, default=None, help="beaker radius in Å (default from atom count)")
    ap.add_argument("--min-dist", type=float, default=2.0, help="closest start distance between atoms, Å")
    ap.add_argument("--method", default="uma", help="uma or emt")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--report", type=float, default=0.1, help="print the pot every this many ps")
    ap.add_argument("--xyz", help="write the trajectory here (extended XYZ)")
    ap.add_argument("--no-finish", action="store_true", help="skip H saturation and the QuMol optimization")
    args = ap.parse_args()

    symbols = parse_recipe(args.recipe)
    t0 = time.perf_counter()
    base = make_base(args.method)
    warm = Atoms(symbols[:2], positions=[[0, 0, 0], [0, 0, 1.3]])
    warm.info.update({"charge": 0, "spin": 1 if sum(warm.numbers) % 2 == 0 else 2})
    warm.calc = base
    warm.get_potential_energy()  # load / compile now, so the first step isn't counted
    print(f"recipe {hill_formula(symbols)}, method {args.method}, T={args.temp:.0f} K, "
          f"setup {time.perf_counter() - t0:.1f}s")
    atoms, st = cook(base, symbols, args.temp, args.heat, args.hold, args.cool, args.dt, args.friction,
                     args.radius, args.min_dist, args.seed, args.report, args.xyz)
    print(f"\nbeaker R={st['radius']:.2f} Å, first bond after {st['first_bond_fs']} fs, peak T_kin "
          f"{st['t_kin_max']:.0f} K; MD {st['steps']} steps in {st['t_md']:.1f}s "
          f"({st['ms_per_call']:.1f} ms/call); quench {st['quench_steps']} steps")
    print("products after quench:")
    syms = atoms.get_chemical_symbols()
    groups = fragments(atoms)
    for g in groups:
        print(f"  {hill_formula([syms[k] for k in g]):10s} {smiles(atoms, g) or '(no SMILES)'}")
    if not args.no_finish:
        heavy = max(groups, key=lambda g: sum(syms[k] != "H" for k in g))
        r = finish(qumol_calculator(base, args.method), atoms, heavy)
        print(f"largest fragment, saturated and optimized: {r}")


if __name__ == "__main__":
    main()
