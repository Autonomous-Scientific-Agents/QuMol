"""Export collected molecules as extended XYZ (one frame per optimised geometry).

Usage:
    python scripts/export_dataset.py --db qumol.db --out qumol_dataset.xyz [--stable-only] [--method toyff]

Each frame carries the HashMol3D id, formula, SMILES, method, energy, stability,
PubChem status and the discoverer's nickname (players are credited by the name they chose).
"""

import argparse
import sqlite3


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="qumol.db")
    ap.add_argument("--out", default="qumol_dataset.xyz")
    ap.add_argument("--stable-only", action="store_true")
    ap.add_argument("--method", default=None, help="method name, e.g. toyff or uma")
    a = ap.parse_args()

    con = sqlite3.connect(a.db)
    con.row_factory = sqlite3.Row
    where = ["1=1"]
    args = []
    if a.stable_only:
        where.append("s.stable=1")
    if a.method:
        where.append("m.name=?")
        args.append(a.method)
    rows = con.execute(
        f"""SELECT g.id, g.xyz, s.formula, s.smiles, s.e_opt, s.stable, s.in_pubchem,
                   m.name AS method, m.version AS mver, m.energy_unit, p.nickname,
                   MIN(s.created_at) AS first_seen
            FROM submissions s
            JOIN geometries g ON g.id = s.optimized_geometry_id
            JOIN methods m ON m.id = s.method_id
            JOIN players p ON p.id = s.player_id
            WHERE {' AND '.join(where)}
            GROUP BY g.id, m.id ORDER BY first_seen""",
        args,
    ).fetchall()
    with open(a.out, "w") as f:
        for r in rows:
            lines = r["xyz"].splitlines()
            pub = {1: "known", 0: "new", None: "unknown"}[r["in_pubchem"]]
            lines[1] = (
                f'hashmol3d="{r["id"]}" formula={r["formula"]} smiles="{r["smiles"] or ""}" '
                f'method="{r["method"]}:{r["mver"]}" energy={r["e_opt"]:.8g} energy_unit="{r["energy_unit"]}" '
                f'stable={bool(r["stable"])} pubchem={pub} discoverer="{r["nickname"]}" '
                f'Properties=species:S:1:pos:R:3'
            )
            f.write("\n".join(lines) + "\n")
    print(f"Wrote {len(rows)} structures to {a.out}")


if __name__ == "__main__":
    main()
