"""Toy force field: the same model the browser prototype uses.

Harmonic bonds and angles plus soft non-bonded repulsion, minimised with FIRE.
It is a gameplay placeholder, not real chemistry: it has no torsions,
electrostatics or dispersion, so every bonding pattern relaxes to an energy
near zero. Swap in a real potential (see ``ase_calc.py``) for science.
"""

from __future__ import annotations

import numpy as np

from ..chem import ELEMENTS, Molecule
from . import Calculator, OptResult, register

KB, KA, KR = 300.0, 60.0, 5.0
ORDER = {1: 1.0, 2: 0.87, 3: 0.78}


def _hyb_cos(mol: Molecule, i: int) -> float:
    orders = [o for a, b, o in mol.bonds if a == i or b == i]
    dbl = orders.count(2)
    if 3 in orders or dbl >= 2:
        return -1.0  # linear
    if dbl == 1:
        return -0.5  # trigonal
    return -1.0 / 3.0  # tetrahedral


class ToyFF(Calculator):
    name = "toyff"
    version = "1"
    kind = "force-field"
    energy_unit = "kcal/mol"
    skill_scale = 2.0
    needs_bonds = True

    def params(self):
        return {"KB": KB, "KA": KA, "KR": KR, "optimizer": "FIRE", "ftol": 0.02}

    # ------------------------------------------------------------- setup
    def build(self, mol: Molecule):
        sym = mol.symbols
        n = len(sym)
        r = {s: ELEMENTS[s]["r"] for s in ELEMENTS}
        bl = [(a, b, (r[sym[a]] + r[sym[b]]) * ORDER[o]) for a, b, o in mol.bonds]
        ang = []
        for j in range(n):
            nb = mol.neighbors(j)
            c0 = _hyb_cos(mol, j)
            for x in range(len(nb)):
                for y in range(x + 1, len(nb)):
                    ang.append((nb[x], j, nb[y], c0))
        excl = {(min(a, b), max(a, b)) for a, b, _ in bl} | {(min(i, k), max(i, k)) for i, _, k, _ in ang}
        nbp = []
        for i in range(n):
            for j in range(i + 1, n):
                if (i, j) in excl:
                    continue
                hi, hj = sym[i] == "H", sym[j] == "H"
                nbp.append((i, j, 2.0 if hi and hj else 2.4 if hi or hj else 2.9))

        def arr(rows, cols, dtypes):
            if not rows:
                return [np.zeros(0, dtype=d) for d in dtypes]
            t = list(zip(*rows))
            return [np.asarray(t[c], dtype=d) for c, d in zip(range(cols), dtypes)]

        self._bl = arr(bl, 3, (int, int, float))
        self._ang = arr(ang, 4, (int, int, int, float))
        self._nbp = arr(nbp, 3, (int, int, float))

    def energy_grad(self, x: np.ndarray):
        g = np.zeros_like(x)
        E = 0.0
        a, b, r0 = self._bl
        if a.size:
            d = x[a] - x[b]
            r = np.linalg.norm(d, axis=1) + 1e-12
            dd = r - r0
            E += KB * np.sum(dd * dd)
            f = (2 * KB * dd / r)[:, None] * d
            np.add.at(g, a, f)
            np.add.at(g, b, -f)
        i, j, k, c0 = self._ang
        if i.size:
            A = x[i] - x[j]
            B = x[k] - x[j]
            la = np.linalg.norm(A, axis=1) + 1e-12
            lb = np.linalg.norm(B, axis=1) + 1e-12
            c = np.sum(A * B, axis=1) / (la * lb)
            dd = c - c0
            E += KA * np.sum(dd * dd)
            f = 2 * KA * dd
            gi = f[:, None] * (B / (la * lb)[:, None] - A * (c / la**2)[:, None])
            gk = f[:, None] * (A / (la * lb)[:, None] - B * (c / lb**2)[:, None])
            np.add.at(g, i, gi)
            np.add.at(g, k, gk)
            np.add.at(g, j, -(gi + gk))
        p, q, d0 = self._nbp
        if p.size:
            D = x[p] - x[q]
            r = np.linalg.norm(D, axis=1) + 1e-12
            m = r < d0
            if m.any():
                dd = d0[m] - r[m]
                E += KR * np.sum(dd * dd)
                f = (-2 * KR * dd / r[m])[:, None] * D[m]
                np.add.at(g, p[m], f)
                np.add.at(g, q[m], -f)
        return E, g

    # ------------------------------------------------------------- FIRE
    def fire(self, x, mask=None, max_steps=4000, ftol=0.02, record=None):
        v = np.zeros_like(x)
        dt, alpha, npos = 0.02, 0.1, 0
        E, fmax, steps = 0.0, 0.0, 0
        for steps in range(max_steps):
            E, g = self.energy_grad(x)
            if mask is not None:
                g[~mask] = 0.0
            fmax = float(np.linalg.norm(g, axis=1).max())
            if record is not None and steps % 4 == 0:
                record.append(x.copy())
            if fmax < ftol:
                break
            P = -np.sum(g * v)
            vn = np.linalg.norm(v)
            fn = np.linalg.norm(g) or 1e-12
            if P > 0:
                v = (1 - alpha) * v - alpha * vn * g / fn
                npos += 1
                if npos > 5:
                    dt = min(dt * 1.1, 0.07)
                    alpha *= 0.99
            else:
                v[:] = 0.0
                dt = max(dt * 0.5, 1e-3)
                alpha, npos = 0.1, 0
            v -= g * dt
            step = v * dt
            L = np.linalg.norm(step, axis=1)
            big = L > 0.1
            step[big] *= (0.1 / L[big])[:, None]
            x += step
            if mask is not None:
                v[~mask] = 0.0
        if record is not None:
            record.append(x.copy())
        return E, fmax, fmax < ftol, steps

    # ------------------------------------------------------------- API
    def optimize(self, mol: Molecule, seed: int = 0) -> OptResult:
        self.build(mol)
        x = np.array(mol.coords, dtype=float)
        is_h = np.array([s == "H" for s in mol.symbols])
        # Tidy hydrogens only, so the player is judged on the skeleton they built.
        if is_h.any():
            self.fire(x, mask=is_h, max_steps=1500)
        coords_input = x.copy()
        e_input, _ = self.energy_grad(x)
        frames = [x.copy()]
        E, fmax, conv, n = self.fire(x, record=frames)
        # Nudge test: if a small kick lowers the energy, it was stuck on a saddle.
        rng = np.random.default_rng(seed)
        y = x + rng.uniform(-0.06, 0.06, size=x.shape)
        E2, fmax2, conv2, n2 = self.fire(y)
        saddle = E2 < E - 0.05
        if saddle:
            x, E, fmax, conv = y, E2, fmax2, conv2
            frames.append(x.copy())
        return OptResult(
            e_input=float(e_input), e_opt=float(E), coords_input=coords_input, coords_opt=x,
            fmax=fmax, converged=bool(conv), saddle=bool(saddle),
            n_steps=int(n), frames=frames,
        )


register("toyff")(ToyFF)
