"""Build Cartesian coordinates for the SE100 semi-experimental equilibrium structures.

The SE100 Supporting Information lists bond lengths, angles and a few dihedrals,
keyed to atom labels. For each molecule this script:
  1. builds the molecule from a labeled SMILES (puzzles/se100_molecules.py),
  2. embeds a starting 3D structure (RDKit ETKDG + MMFF) in the right conformer,
  3. fits the Cartesian coordinates to every SE parameter by least squares,
  4. cross-checks the result with a GFN2-xTB optimization started from the fit
     (a mislabeled parameter shows up as a large deviation), and uses the same
     check to decide ambiguous cis/trans hydrogen labels.

    python3 scripts/build_se_geometries.py            # writes puzzles/se100_geometries.json
    python3 scripts/build_se_geometries.py --only Furan --verbose

Needs rdkit, scipy, ase and tblite (pip install tblite) for the cross-check.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import re
import sys

import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem, rdMolTransforms
from scipy.optimize import least_squares

HERE = os.path.dirname(os.path.abspath(__file__))
PUZ = os.path.join(HERE, "..", "puzzles")
sys.path.insert(0, PUZ)
from se100_molecules import MOLECULES  # noqa: E402

LABEL = re.compile(r"([A-Z][a-z]?)(\d+)")
REFERENCE = {
    "text": "G. Ceselin, V. Barone, N. Tasinato, J. Chem. Theory Comput. 17, 7290-7311 (2021), "
            "SE100 database, Table S1 (SE column)",
    "doi": "10.1021/acs.jctc.1c00788",
    "license": "CC BY 4.0",
}


def read_params(path):
    data, cur = {}, None
    for line in open(path):
        line = line.rstrip("\n")
        if line.startswith("# "):
            cur = line[2:].strip()
            data.setdefault(cur, [])
        elif line and line[0] in "rad" and line[1] == " " and cur is not None:
            kind, lab, val = line.split()
            data[cur].append((kind, lab, float(val)))
    return {k: v for k, v in data.items() if v}


def labels_of(s):
    return [f"{e}{n}" for e, n in LABEL.findall(s)]


def build_mol(smiles):
    ps = Chem.SmilesParserParams()
    ps.removeHs = False
    m = Chem.MolFromSmiles(smiles, ps)
    if m is None:
        raise ValueError(f"bad SMILES {smiles}")
    lab = [f"{a.GetSymbol()}{a.GetAtomMapNum()}" for a in m.GetAtoms()]
    return m, lab


def swap_labels(text, swap):
    toks = LABEL.findall(text)
    if not swap or "".join(e + n for e, n in toks) != text.replace("-", "").replace("=", "").replace("#", ""):
        return text
    out = []
    for e, n in toks:
        t = e + n
        for a, b in swap:
            t = b if t == a else a if t == b else t
        out.append(t)
    return "-".join(out) if len(out) == 2 else "".join(out)


def paths(m, lab, labs):
    """Atom index tuples, connected by bonds, whose labels match labs."""
    n = len(labs)
    nbr = {a.GetIdx(): [x.GetIdx() for x in a.GetNeighbors()] for a in m.GetAtoms()}
    out = []

    def grow(p):
        if len(p) == n:
            out.append(tuple(p))
            return
        for j in nbr[p[-1]]:
            if j not in p and lab[j] == labs[len(p)]:
                grow(p + [j])

    for i in range(m.GetNumAtoms()):
        if lab[i] == labs[0]:
            grow([i])
    # an a-b-c path and its reverse are the same parameter
    seen, uniq = set(), []
    for p in out:
        key = min(p, p[::-1])
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return uniq


def dist(x, i, j):
    return np.linalg.norm(x[i] - x[j])


def angle(x, i, j, k):
    a, b = x[i] - x[j], x[k] - x[j]
    c = a @ b / np.linalg.norm(a) / np.linalg.norm(b)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


def dihedral(x, i, j, k, l):
    b0, b1, b2 = x[i] - x[j], x[k] - x[j], x[l] - x[k]
    b1n = b1 / np.linalg.norm(b1)
    v = b0 - (b0 @ b1n) * b1n
    w = b2 - (b2 @ b1n) * b1n
    return np.degrees(np.arctan2(np.cross(b1n, v) @ w, v @ w))


def wrap(d):
    return (d + 180.0) % 360.0 - 180.0


def targets_for(key, spec, params, m, lab, swap=()):
    fix, skip = spec.get("fix", {}), set(spec.get("skip", []))
    tg, problems = [], []
    supp = set(spec.get("supplement", []))
    rows = [(k, swap_labels(fix.get(l, l), swap), 180.0 - v if l in supp else v)
            for k, l, v in params if l not in skip]
    rows += [("d", l, v) for l, v in spec.get("conf", {}).items()]
    for kind, l, v in rows:
        labs = labels_of(l)
        need = {"r": 2, "a": 3, "d": 4}[kind]
        if len(labs) != need:
            problems.append(f"can't parse {kind} {l}")
            continue
        ps = paths(m, lab, labs)
        if not ps:
            problems.append(f"no atoms match {kind} {l}")
            continue
        tg.append((kind, l, v, ps))
    return tg, problems


def evaluate(x, kind, p):
    kind = kind.lower()
    if kind == "r":
        return dist(x, *p)
    if kind == "a":
        return angle(x, *p)
    return dihedral(x, *p)


def expand(tg, x0):
    """One (kind, atoms, target) row per matched path. Symmetry-equivalent dihedrals come
    in mirror pairs (+phi, -phi): each takes the sign it has in the starting structure."""
    rows = []
    for kind, _, v, ps in tg:
        for p in ps:
            # "D" rows: a symmetry-equivalent dihedral whose sign is free (mirror images)
            rows.append(("D" if kind == "d" and len(ps) > 1 else kind, p, v))
    return rows


def residuals(x, rows, x0, reg, far=()):
    x = x.reshape(-1, 3)
    out = []
    for i, j in far:  # atoms not bonded to each other must not collapse onto each other
        d = np.linalg.norm(x[i] - x[j])
        out.append(max(0.0, 1.4 - d) / 0.01)
    for kind, p, t in rows:
        val = evaluate(x, kind, p)
        if kind == "r":
            out.append((val - t) / 2e-4)
        elif kind == "a":
            out.append((val - t) / 0.02)
        elif kind == "d":
            out.append(wrap(val - t) / 0.02)
        else:
            out.append(min(abs(wrap(val - t)), abs(wrap(val + t))) / 0.02)
    out.extend(((x - x0) * reg).ravel())
    return np.array(out)


def start_geometry(m, tg, seed=7):
    mh = Chem.Mol(m)
    if AllChem.EmbedMolecule(mh, randomSeed=seed) != 0:
        AllChem.EmbedMolecule(mh, randomSeed=seed, useRandomCoords=True)
    try:
        if AllChem.MMFFOptimizeMolecule(mh, maxIters=2000) == -1:
            raise ValueError
    except Exception:
        AllChem.UFFOptimizeMolecule(mh, maxIters=2000)
    conf = mh.GetConformer()
    ri = mh.GetRingInfo()
    for kind, _, v, ps in tg:  # put the start in the right conformer
        # unique dihedrals, and symmetric ones that are 0 or 180 (no mirror sign to pick)
        if kind != "d" or (len(ps) != 1 and abs(abs(v) - 90) < 89.9):
            continue
        for i, j, k, l in ps:
            if ri.NumBondRings(mh.GetBondBetweenAtoms(j, k).GetIdx()):
                continue
            try:
                rdMolTransforms.SetDihedralDeg(conf, i, j, k, l, v)
            except Exception:
                pass
    return np.array(conf.GetPositions())


def fit(m, tg, seeds=40):
    """Least-squares fit from several starting structures; keep the best. Different starts
    matter when symmetry-equivalent dihedrals (methyl hydrogens) must pick the right sides."""
    best = None
    for seed in range(1, seeds + 1):
        x0 = start_geometry(m, tg, seed)
        rows = expand(tg, x0)
        dm = Chem.GetDistanceMatrix(m)
        far = [(i, j) for i in range(len(x0)) for j in range(i) if dm[i, j] >= 2]
        x = x0
        for reg in (0.05, 0.005):  # pull hard toward the start first, then let go
            r = least_squares(residuals, x.ravel(), args=(rows, x0, reg, far), method="trf",
                              xtol=1e-12, ftol=1e-12, gtol=1e-12, max_nfev=4000)
            x = r.x.reshape(-1, 3)
        _, worst = max_errors(x, tg)
        if best is None or worst[0] < best[0]:
            best = (worst[0], x)
        if worst[0] < 0.2:  # within 0.2 mÅ and 0.02°: good enough
            break
    return best[1]


def max_errors(x, tg):
    err = {"r": 0.0, "a": 0.0, "d": 0.0}
    worst = None
    for kind, l, v, ps in tg:
        for p in ps:
            val = evaluate(x, kind, p)
            d = abs(val - v) if kind != "d" else abs(wrap(abs(val) - abs(v)) if len(ps) > 1 else wrap(val - v))
            if d > err[kind]:
                err[kind] = d
            scale = d / (1e-3 if kind == "r" else 0.1)
            if worst is None or scale > worst[0]:
                worst = (scale, kind, l, v, round(float(val), 4))
    return err, worst


def kabsch_rmsd(a, b):
    a = a - a.mean(0)
    b = b - b.mean(0)
    u, s, vt = np.linalg.svd(a.T @ b)
    d = np.sign(np.linalg.det(u @ vt))
    s[-1] *= d
    return float(np.sqrt(max((a ** 2).sum() + (b ** 2).sum() - 2 * s.sum(), 0) / len(a)))


def xtb_check(m, x, tg):
    """Relax with GFN2-xTB from the fitted structure; return (rmsd, angle score, coords)."""
    try:
        from ase import Atoms
        from ase.optimize import BFGS
        from tblite.ase import TBLite
    except ImportError:
        return None, None, None
    nrad = sum(a.GetNumRadicalElectrons() for a in m.GetAtoms())
    at = Atoms([a.GetSymbol() for a in m.GetAtoms()], positions=x)
    at.calc = TBLite(method="GFN2-xTB", charge=0, multiplicity=nrad + 1, verbosity=0)
    try:
        BFGS(at, logfile=None).run(fmax=0.005, steps=500)
    except Exception as e:
        print("   xTB failed:", e)
        return None, None, None
    y = at.get_positions()
    score = 0.0
    for kind, _, v, ps in tg:
        if kind == "a":
            for p in ps:
                score += (angle(y, *p) - v) ** 2
    return kabsch_rmsd(x, y), score, y


def bonds_of(m):
    mk = Chem.Mol(m)
    Chem.Kekulize(mk, clearAromaticFlags=True)
    return [[b.GetBeginAtomIdx(), b.GetEndAtomIdx(), int(b.GetBondTypeAsDouble())] for b in mk.GetBonds()]


def canonical_smiles(m):
    mm = Chem.Mol(m)
    for a in mm.GetAtoms():
        a.SetAtomMapNum(0)
    return Chem.MolToSmiles(Chem.RemoveHs(mm))


def formula(m):
    from rdkit.Chem.rdMolDescriptors import CalcMolFormula
    return CalcMolFormula(m)


def process(key, spec, params, verbose=False, use_xtb=True):
    options = [()]
    for pair in spec.get("swap", []):
        options = [o + (pair,) for o in options] + options
    results = []
    for sw in options:
        m, lab = build_mol(spec["smiles"])
        tg, problems = targets_for(key, spec, params, m, lab, sw)
        if problems:
            return {"key": key, "problems": problems}
        x = fit(m, tg)
        err, worst = max_errors(x, tg)
        rmsd, score, _ = xtb_check(m, x, tg) if use_xtb else (None, None, None)
        results.append(dict(swap=sw, m=m, x=x, tg=tg, err=err, worst=worst, rmsd=rmsd, score=score))
        if verbose:
            print(f"  {key} swap={sw} err={err} worst={worst} xtb_rmsd={rmsd} score={score}")
    if use_xtb and len(results) > 1:
        results.sort(key=lambda r: (r["score"] is None, r["score"] or 0))
    r = results[0]
    m, x = r["m"], r["x"] - r["x"].mean(0)
    heavy = sum(a.GetAtomicNum() > 1 for a in m.GetAtoms())
    nrad = sum(a.GetNumRadicalElectrons() for a in m.GetAtoms())
    out = {
        "key": key,
        "name": spec["name"],
        "formula": formula(m),
        "smiles": canonical_smiles(m),
        "heavy": heavy,
        "multiplicity": nrad + 1,
        "atoms": [[a.GetSymbol(), *[round(float(c), 5) for c in x[i]]] for i, a in enumerate(m.GetAtoms())],
        "labels": [f"{a.GetSymbol()}{a.GetAtomMapNum()}" for a in m.GetAtoms()],
        "bonds": bonds_of(m),
        "n_params": len(params),
        "fit_max_error": {"bond_A": round(float(r["err"]["r"]), 5), "angle_deg": round(float(r["err"]["a"]), 3),
                          "dihedral_deg": round(float(r["err"]["d"]), 3)},
        "xtb_rmsd_A": None if r["rmsd"] is None else round(r["rmsd"], 4),
        "notes": [],
        "reference": REFERENCE,
    }
    if spec.get("fix"):
        out["notes"].append("corrected SI label misprints: " + ", ".join(f"{a}->{b}" for a, b in spec["fix"].items()))
    if spec.get("supplement"):
        out["notes"].append("printed dihedral taken as its supplement (180-x), matching the figure: "
                            + ", ".join(spec["supplement"]))
    if spec.get("conf"):
        out["notes"].append("conformer: " + ", ".join(f"{a}={b:g}" for a, b in spec["conf"].items()))
    if r["swap"]:
        out["notes"].append("cis/trans H labels chosen by GFN2-xTB: swapped " + ", ".join("/".join(p) for p in r["swap"]))
    if len(results) > 1 and results[0]["score"] is not None:
        out["notes"].append("label check scores (lower is better): " + ", ".join(
            f"{'swapped' if q['swap'] else 'as drawn'}={q['score']:.1f}" for q in results))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--params", default=os.path.join(PUZ, "se100_params.txt"))
    ap.add_argument("--out", default=os.path.join(PUZ, "se100_geometries.json"))
    ap.add_argument("--only", help="substring of the molecule key or name")
    ap.add_argument("--no-xtb", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    params = read_params(a.params)
    missing = set(params) - set(MOLECULES)
    if missing:
        print("No structure definition for:", sorted(missing))
    out, bad = [], []
    for key, spec in MOLECULES.items():
        if a.only and a.only.lower() not in (key + spec["name"]).lower():
            continue
        if key not in params:
            bad.append((key, "not in params file"))
            continue
        r = process(key, spec, params[key], a.verbose, not a.no_xtb)
        if "problems" in r:
            bad.append((key, r["problems"]))
            continue
        e = r["fit_max_error"]
        flag = "" if e["bond_A"] < 2e-3 and e["angle_deg"] < 0.2 and e["dihedral_deg"] < 1 else "  <-- poor fit"
        if r["xtb_rmsd_A"] is not None and r["xtb_rmsd_A"] > 0.05:
            flag += "  <-- far from xTB"
        print(f"{r['name']:<28} {r['formula']:<10} heavy={r['heavy']:<2} fit {e} xtb_rmsd={r['xtb_rmsd_A']}{flag}")
        out.append(r)
    for k, p in bad:
        print("PROBLEM", k, p)
    if not a.only:
        with open(a.out, "w") as f:
            json.dump({"source": REFERENCE, "molecules": out}, f, indent=1)
        print(f"Wrote {len(out)} molecules to {a.out}")


if __name__ == "__main__":
    main()
