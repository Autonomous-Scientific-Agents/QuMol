"""Time geometry optimizations with an ASE energy method on this machine.

    ~/qumol/.venv/bin/python scripts/bench_uma.py                 # UMA, default settings, BFGS vs FIRE
    QUMOL_UMA_SETTINGS=batch ~/qumol/.venv/bin/python scripts/bench_uma.py
    ~/qumol/.venv/bin/python scripts/bench_uma.py emt              # quick sanity run without UMA

Run it once per QUMOL_UMA_SETTINGS value you want to compare. Each molecule is a new
composition, like real submissions, so set-up costs (merging, compiling) are included.
"""

import os
import sys
import time

sys.path.insert(0, __file__.rsplit("/scripts/", 1)[0])

import numpy as np  # noqa: E402

from qumol.calculators import get_calculator  # noqa: E402
from qumol.chem import validate  # noqa: E402

method = sys.argv[1] if len(sys.argv) > 1 else "uma"
rng = np.random.default_rng(0)


def jitter(xyz, amount=0.12):
    return np.asarray(xyz, float) + rng.uniform(-amount, amount, (len(xyz), 3))


ring = [[1.397 * np.cos(k * np.pi / 3), 1.397 * np.sin(k * np.pi / 3), 0] for k in range(6)]
ringH = [[2.48 * np.cos(k * np.pi / 3), 2.48 * np.sin(k * np.pi / 3), 0] for k in range(6)]
cases = {
    "water": (["O", "H", "H"], [[0, 0, 0], [0.96, 0, 0], [-0.24, 0.93, 0]], [(0, 1, 1), (0, 2, 1)]),
    "ethanol": (["C", "C", "O", "H", "H", "H", "H", "H", "H"],
                [[0, 0, 0], [1.52, 0, 0], [2.0, 1.35, 0], [-0.36, 1.03, 0], [-0.36, -0.51, 0.89],
                 [-0.36, -0.51, -0.89], [1.88, -0.51, 0.89], [1.88, -0.51, -0.89], [2.97, 1.35, 0]],
                [(0, 1, 1), (1, 2, 1), (0, 3, 1), (0, 4, 1), (0, 5, 1), (1, 6, 1), (1, 7, 1), (2, 8, 1)]),
    "benzene": (["C"] * 6 + ["H"] * 6, ring + ringH,
                [(k, (k + 1) % 6, 2 if k % 2 == 0 else 1) for k in range(6)] + [(k, k + 6, 1) for k in range(6)]),
}

print(f"method={method} settings={os.environ.get('QUMOL_UMA_SETTINGS', 'default')} "
      f"device={os.environ.get('QUMOL_DEVICE', 'cpu')}")
t = time.time()
calc = get_calculator(method)
calc.calc  # load the model now so loading isn't counted per molecule
print(f"model load: {time.time() - t:.1f}s")
for opt in ("BFGS", "FIRE"):
    os.environ["QUMOL_OPTIMIZER"] = opt
    for name, (sym, xyz, bonds) in cases.items():
        mol = validate(sym, jitter(xyz), bonds)
        t0 = time.time()
        res = calc.optimize(mol)
        print(f"  {opt:5s} {name:8s} steps={res.n_steps:4d} converged={res.converged} "
              f"E={res.e_opt:.4f} time={time.time() - t0:6.1f}s")
