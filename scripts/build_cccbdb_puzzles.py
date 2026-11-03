"""Turn CCCBDB experimental geometries into a QuMol puzzle file.

Input: a JSON list as collected from CCCBDB experimental-geometry pages (casno, name,
formula, atoms [[label, x, y, z]], bonds [[label, label]], references). CCCBDB gives
connectivity but not bond orders; orders come from RDKit's DetermineBondOrders on the
experimental geometry, and every molecule must pass QuMol's own validation.

CCCBDB is NIST Standard Reference Data (SRD 101, "all rights reserved"), so the
output is NOT stored in this repository (data/ is git-ignored). Put it in the
'puzzles' folder next to the database, where the server picks it up on restart
(or list it in QUMOL_PUZZLE_FILES):

    python3 scripts/build_cccbdb_puzzles.py cccbdb_raw.json --out data/puzzles/cccbdb_geometries.json

Molecules already in the SE100 set (same SMILES) are skipped: the SE100 semi-experimental
equilibrium structures are the better reference for comparison with optimized geometries.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from qumol.chem import ELEMENTS, ChemError, hill_formula, smiles_of, structure_problem, validate  # noqa: E402

ALLOWED = {"H", "C", "N", "O", "S", "F"}
LABEL = re.compile(r"^([A-Z][a-z]?)(\d+)$")


def formula_counts(f: str) -> dict:
    """Element counts of a condensed formula like CH3CH(CH3)CH3 or N(CH3)3."""
    def parse(s, i=0):
        cnt = {}
        while i < len(s) and s[i] != ")":
            if s[i] == "(":
                sub, i = parse(s, i + 1)
                i += 1
                m = re.match(r"\d*", s[i:]).group()
                i += len(m)
                for k, v in sub.items():
                    cnt[k] = cnt.get(k, 0) + v * int(m or 1)
            else:
                m = re.match(r"([A-Z][a-z]?)(\d*)", s[i:])
                if not m:
                    raise ValueError(f"can't read formula {f!r}")
                cnt[m.group(1)] = cnt.get(m.group(1), 0) + int(m.group(2) or 1)
                i += len(m.group())
        return cnt, i
    return parse(f)[0]


def distance_bonds(symbols, coords):
    """Connectivity from interatomic distances (covalent radii, 15% slack)."""
    out = []
    for i in range(len(symbols)):
        for j in range(i + 1, len(symbols)):
            r0 = ELEMENTS[symbols[i]]["r"] + ELEMENTS[symbols[j]]["r"]
            if np.linalg.norm(coords[i] - coords[j]) < 1.15 * r0:
                out.append((i, j))
    return out


RENAME = {  # CCCBDB names that would mislead in a puzzle
    ("Carbonyl fluoride", 2): "Fluoroformyl radical",
    ("Thiomethoxy", 2): "Methylthio radical",
}


def nice_name(name: str, multiplicity: int = 1) -> str:
    """CCCBDB index names like 'Ethane, 1,1-difluoro-' -> '1,1-Difluoroethane',
    'Ethene, 1,2-difluoro-, (E)-' -> '(E)-1,2-Difluoroethene'."""
    if (name, multiplicity) in RENAME:
        return RENAME[(name, multiplicity)]
    stereo = ""
    m = re.match(r"^(.*), (\([EZ]\))-$", name.strip())
    if m:
        name, stereo = m.group(1), m.group(2) + "-"
    m = re.match(r"^(.+?), (.+-)$", name.strip())
    if m:
        base, sub = m.group(1), m.group(2)
        k = next((i for i, c in enumerate(base) if c.isalpha()), 0)
        base = base[:k] + base[k].lower() + base[k + 1:]  # 1,3-Butadiene -> 1,3-butadiene
        name = sub + base if base[0].isdigit() else sub.rstrip("-") + base
    name = stereo + name
    for i, ch in enumerate(name):  # capitalize the first letter, after locants like 1,1- or (E)-
        if ch.isalpha() and not (name[i:i + 3] in ("(E)", "(Z)") or (i > 0 and name[i - 1] == "(" and name[i + 1:i + 2] == ")")):
            name = name[:i] + ch.upper() + name[i + 1:]
            break
    if multiplicity == 2 and "radical" not in name.lower():
        name += " radical"
    return name


def bond_orders(symbols, coords, pairs):
    """Bond orders from connectivity + geometry (RDKit), as [(i, j, order)]."""
    from rdkit import Chem
    from rdkit.Chem import rdDetermineBonds
    from rdkit.Geometry import Point3D

    m = Chem.RWMol()
    for s in symbols:
        m.AddAtom(Chem.Atom(s))
    for a, b in pairs:
        m.AddBond(a, b, Chem.BondType.SINGLE)
    conf = Chem.Conformer(len(symbols))
    for i, (x, y, z) in enumerate(coords):
        conf.SetAtomPosition(i, Point3D(float(x), float(y), float(z)))
    m.AddConformer(conf, assignId=True)
    mol = m.GetMol()
    rdDetermineBonds.DetermineBondOrders(mol, charge=0, allowChargedFragments=True)
    Chem.Kekulize(mol, clearAromaticFlags=True)
    return [(b.GetBeginAtomIdx(), b.GetEndAtomIdx(), int(b.GetBondTypeAsDouble())) for b in mol.GetBonds()]


def search_orders(symbols, coords, pairs, radicals=None, max_heavy_bonds=10):
    """Try every order on the heavy-atom bonds; keep a valid assignment with the wanted
    number of unpaired electrons (or the fewest), preferring high orders on short bonds."""
    import itertools

    heavy = [k for k, (a, b) in enumerate(pairs) if symbols[a] != "H" and symbols[b] != "H"]
    if len(heavy) > max_heavy_bonds:
        raise ValueError("too many bonds to search")
    r0 = [ELEMENTS[symbols[a]]["r"] + ELEMENTS[symbols[b]]["r"] for a, b in pairs]
    shortness = [r0[k] - float(np.linalg.norm(coords[a] - coords[b])) for k, (a, b) in enumerate(pairs)]
    best = None
    for combo in itertools.product((1, 2, 3), repeat=len(heavy)):
        orders = [1] * len(pairs)
        for k, o in zip(heavy, combo):
            orders[k] = o
        bonds = [(a, b, o) for (a, b), o in zip(pairs, orders)]
        try:
            mol = validate(symbols, coords, bonds)
        except ChemError:
            continue
        if radicals is not None and mol.radicals != radicals:
            continue
        fit = sum((o - 1) * shortness[k] for k, o in enumerate(orders))
        charged = sum(1 for q in (mol.charges or []) if q)
        key = (mol.radicals, charged, -fit)  # fewest unpaired electrons, then fewest formal charges
        if best is None or key < best[0]:
            best = (key, bonds)
    if best is None:
        raise ValueError("no valid bond orders")
    return best[1]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("raw")
    ap.add_argument("--out", default="data/puzzles/cccbdb_geometries.json")
    ap.add_argument("--states", help="JSON {casno: ground-state term, e.g. '2A1'} to check spin")
    ap.add_argument("--se100", default=str(Path(__file__).resolve().parent.parent / "puzzles" / "se100_geometries.json"))
    a = ap.parse_args()

    raw = json.loads(Path(a.raw).read_text())
    states = json.loads(Path(a.states).read_text()) if a.states else {}
    se_smiles = set()
    if Path(a.se100).exists():
        for m in json.loads(Path(a.se100).read_text())["molecules"]:
            try:
                se_smiles.add(smiles_of(validate([x[0] for x in m["atoms"]], [x[1:] for x in m["atoms"]],
                                                 [tuple(b) for b in m["bonds"]])))
            except ChemError:
                pass

    out, skipped, seen = [], [], set()
    for r in raw:
        labels = [x[0] for x in r["atoms"]]
        try:
            symbols = [LABEL.match(l).group(1) for l in labels]
        except AttributeError:
            skipped.append((r["name"], "unreadable atom labels"))
            continue
        coords = np.array([x[1:4] for x in r["atoms"]], dtype=float)
        idx = {l: i for i, l in enumerate(labels)}
        if set(symbols) - ALLOWED:
            skipped.append((r["name"], "elements"))
            continue
        heavy = sum(s != "H" for s in symbols)
        if not 1 <= heavy <= 10 or len(symbols) < 2:
            skipped.append((r["name"], "size"))
            continue
        try:
            want = formula_counts(r["formula"])
        except ValueError:
            want = None
        have = {e: symbols.count(e) for e in set(symbols)}
        if want is not None and want != have:
            skipped.append((r["name"], f"incomplete coordinates: {r['formula']} but {hill_formula(symbols)} listed"))
            continue
        # CCCBDB's bond tables don't always match its coordinates (different atom numbering,
        # missing bonds), so connectivity comes from the experimental distances.
        pairs = distance_bonds(symbols, coords)
        # Spin from the ground state CCCBDB lists (e.g. 2A1 -> doublet); QuMol must agree.
        state = states.get(r["casno"])
        mult = int(state[0]) if state and state[0].isdigit() else None
        want_rad = None if mult is None else mult - 1
        try:
            try:
                bonds = bond_orders(symbols, coords, pairs)
                if want_rad is not None and validate(symbols, coords, bonds).radicals != want_rad:
                    raise ValueError("spin")
            except (ValueError, ChemError):  # RDKit can't place odd electrons, or chose charges QuMol reads as radicals
                bonds = search_orders(symbols, coords, pairs, radicals=want_rad)
            mol = validate(symbols, coords, bonds)
            smiles = smiles_of(mol)
        except Exception as e:  # radicals and odd valences can defeat bond-order assignment
            skipped.append((r["name"], f"bond orders: {type(e).__name__}: {str(e)[:80]}"))
            continue
        problem = structure_problem(mol, coords)
        if problem:
            skipped.append((r["name"], f"geometry: {problem}"))
            continue
        if smiles in se_smiles:
            skipped.append((r["name"], "already in SE100"))
            continue
        if smiles in seen:
            skipped.append((r["name"], "duplicate"))
            continue
        seen.add(smiles)
        refs = r.get("references") or []
        text = "; ".join(x["text"].strip() for x in refs) or "CCCBDB"
        doi = next((x["doi"] for x in refs if x.get("doi")), None)
        out.append({
            "key": f"cccbdb-{r['casno']}",
            "name": nice_name(r["name"], mol.multiplicity),
            "formula": hill_formula(symbols),
            "smiles": smiles,
            "heavy": heavy,
            "multiplicity": mol.multiplicity,
            "state": states.get(r["casno"]),
            "atoms": [[s, *[round(float(v), 4) for v in c]] for s, c in zip(symbols, coords)],
            "labels": labels,
            "bonds": [list(b) for b in bonds],
            "casno": r["casno"],
            "reference": {"text": f"NIST CCCBDB (SRD 101), CAS {r['casno']}; {text}", "doi": doi},
        })
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps({
        "source": {"text": "NIST Computational Chemistry Comparison and Benchmark Database, SRD 101, "
                           "experimental geometries", "url": "https://cccbdb.nist.gov",
                   "license": "NIST Standard Reference Data: all rights reserved; not redistributed"},
        "molecules": out}, indent=1))
    print(f"Wrote {len(out)} molecules to {a.out}; skipped {len(skipped)}:")
    reasons = {}
    for name, why in skipped:
        reasons.setdefault(why.split(":")[0], []).append(name)
    for why, names in sorted(reasons.items(), key=lambda kv: -len(kv[1])):
        print(f"  {why}: {len(names)}  e.g. {', '.join(names[:6])}")


if __name__ == "__main__":
    main()
