"""Run many cooks (temperatures x beaker sizes x seeds) with one model load and tabulate.

    .venv/bin/python scripts/cook_sweep.py C4N1O1 --temps 500 1500 3000 --radii 3 4.5 --seeds 4
    .venv/bin/python scripts/cook_sweep.py C4N1O1 --method emt --seeds 1     # smoke test

Prints one line per run as it goes, then a summary of the distinct products per setting.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict

sys.path.insert(0, __file__.rsplit("/scripts/", 1)[0])
sys.path.insert(0, __file__.rsplit("/", 1)[0])

from ase import Atoms  # noqa: E402

from cook_md import cook, finish, fragments, make_base, parse_recipe, qumol_calculator  # noqa: E402
from qumol.chem import hill_formula  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recipe")
    ap.add_argument("--temps", type=float, nargs="+", default=[500, 1500, 3000])
    ap.add_argument("--radii", type=float, nargs="+", default=[3.0, 4.5])
    ap.add_argument("--seeds", type=int, default=4)
    ap.add_argument("--heat", type=float, default=0.1)
    ap.add_argument("--hold", type=float, default=0.3)
    ap.add_argument("--cool", type=float, default=0.1)
    ap.add_argument("--method", default="uma")
    ap.add_argument("--json", help="write every run's result here")
    args = ap.parse_args()

    symbols = parse_recipe(args.recipe)
    base = make_base(args.method)
    warm = Atoms(symbols[:2], positions=[[0, 0, 0], [0, 0, 1.3]])
    warm.info.update({"charge": 0, "spin": 1 if sum(warm.numbers) % 2 == 0 else 2})
    warm.calc = base
    warm.get_potential_energy()
    qcalc = qumol_calculator(base, args.method)
    runs = []
    for radius in args.radii:
        for temp in args.temps:
            for seed in range(args.seeds):
                t = time.perf_counter()
                atoms, st = cook(base, symbols, temp, args.heat, args.hold, args.cool, radius=radius, seed=seed)
                syms = atoms.get_chemical_symbols()
                groups = fragments(atoms)
                pot = [hill_formula([syms[k] for k in g]) for g in groups]
                heavy = max(groups, key=len)
                r = finish(qcalc, atoms, heavy)
                row = {"radius": radius, "temp": temp, "seed": seed, "pot": pot, **st, **r,
                       "t_total": time.perf_counter() - t}
                runs.append(row)
                print(f"R={radius:<4} T={temp:<5.0f} seed={seed}  pot: {' + '.join(pot):28s} -> "
                      f"{r.get('smiles') or r.get('error')}  "
                      f"{'stable' if r.get('stable') else 'NOT stable ' + str(r.get('problem') or '')}  "
                      f"[{row['t_total']:.0f}s, peak {st['t_kin_max']:.0f} K]", flush=True)
    print("\nsummary (distinct stable products per setting):")
    by = defaultdict(list)
    for r in runs:
        by[(r["radius"], r["temp"])].append(r)
    for (radius, temp), rs in by.items():
        stable = Counter(r["smiles"] for r in rs if r.get("stable"))
        print(f"  R={radius} T={temp:.0f}: {sum(stable.values())}/{len(rs)} stable; "
              f"{dict(stable) or '-'}; pot pieces {sum(len(r['pot']) for r in rs) / len(rs):.1f} on average")
    times = [r["t_total"] for r in runs]
    print(f"time per cook incl. optimization: {min(times):.0f}-{max(times):.0f}s, mean {sum(times) / len(times):.0f}s")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(runs, f, indent=1, default=str)


if __name__ == "__main__":
    main()
