"""Check that an energy method loads and works, outside the web server.

    ~/qumol/.venv/bin/python scripts/check_calculator.py uma

Uses the same environment variables as the service (QUMOL_UMA_MODEL, QUMOL_DEVICE, HF_TOKEN, ...).
"""

import sys
import time

sys.path.insert(0, __file__.rsplit("/scripts/", 1)[0])

from qumol.calculators import get_calculator  # noqa: E402
from qumol.chem import hash_geometry, smiles_of, validate  # noqa: E402

method = sys.argv[1] if len(sys.argv) > 1 else None
t = time.time()
calc = get_calculator(method)
print(f"method: {calc.name} {calc.version} ({calc.energy_unit})")
cases = {
    "water": (["O", "H", "H"], [[0, 0, 0], [0.96, 0, 0], [-0.24, 0.93, 0]], [(0, 1, 1), (0, 2, 1)]),
    "carbon monoxide": (["C", "O"], [[0, 0, 0], [1.13, 0, 0]], [(0, 1, 3)]),
    "methyl radical": (["C", "H", "H", "H"], [[0, 0, 0], [1.08, 0, 0], [-0.54, 0.94, 0], [-0.54, -0.94, 0]],
                       [(0, 1, 1), (0, 2, 1), (0, 3, 1)]),
}
for name, (sym, xyz, bonds) in cases.items():
    mol = validate(sym, xyz, bonds)
    t0 = time.time()
    res = calc.optimize(mol)
    gid = hash_geometry(mol.symbols, res.coords_opt, multiplicity=mol.multiplicity).id
    print(f"  {name:16s} {smiles_of(mol):12s} E={res.e_opt:.5f} converged={res.converged} "
          f"steps={res.n_steps} {time.time() - t0:.1f}s  {gid}")
print(f"OK in {time.time() - t:.1f}s")
