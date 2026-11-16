"""Cooking mode: bare atoms scattered in a beaker, heated, held, cooled; bonds form on their own.

Langevin molecular dynamics with a reactive potential inside a soft spherical wall, then a
quench. Each fragment with two or more heavy atoms is turned into a product: bond orders
are read from its bond lengths and every free valence gets a hydrogen (like the game's H+).
Products are not scored here; the player picks one and builds it like any other molecule.

The potential is ``QUMOL_COOK_METHOD``: ``ani1xnr`` (default; torchani's reactive C/H/N/O
model, MIT), ``uma`` (slower, needs fairchem) or ``emt`` (crude, for tests).
"""

from __future__ import annotations

import os
import threading
import time

import numpy as np

from .chem import ELEMENTS, ChemError, assign_charges, hill_formula, max_bonds, smiles_of, validate

COOK_ELEMENTS = ("C", "N", "O", "H")  # what ANI-1xnr knows; free valences get H at the end
MIN_ATOMS, MAX_ATOMS = 2, 10  # MAX_ATOMS counts heavy atoms; up to MAX_H hydrogens on top
MAX_H = 10
MIN_FS, MAX_FS, DEFAULT_FS = 15, 1000, 500  # the player picks how long it cooks
MIN_TEMP, MAX_TEMP = 300, 3000
HEAT, HOLD, COOL = 0.2, 0.6, 0.2  # fractions of the cook; bonds form within ~50 fs
DT_FS = 1.0  # heavy atoms only, so 1 fs is safe
DT_FS_H = 0.5  # hydrogens move fast
FRICTION = 0.05  # Langevin friction in 1/fs: carries away the heat of bond formation
WALL_K = 5.0  # eV/Å², the beaker wall


def beaker_radius(n: int) -> float:
    """About 12 Å³ per atom: dense enough that atoms meet and make one or two molecules."""
    return max(3.0, (3 * 12.0 * n / (4 * np.pi)) ** (1 / 3))


# ------------------------------------------------------------------ potential


_beaker_cls = None


def beaker(base, radius: float, lock: threading.Lock, k: float = WALL_K):
    """ASE calculator: the base potential plus a harmonic wall that keeps atoms inside radius R.
    (Defined on first use, so importing this module doesn't need ASE.)"""
    global _beaker_cls
    if _beaker_cls is None:
        from ase.calculators.calculator import Calculator, all_changes

        class Beaker(Calculator):
            implemented_properties = ["energy", "forces"]

            def __init__(self, base, radius, lock, k):
                super().__init__()
                self.base, self.radius, self.lock, self.k = base, radius, lock, k

            def calculate(self, atoms=None, properties=("energy",), system_changes=all_changes):
                super().calculate(atoms, properties, system_changes)
                a = self.atoms.copy()  # keeps info (charge, spin) for UMA
                with self.lock:  # one shared model, called by one thread at a time
                    a.calc = self.base
                    e = a.get_potential_energy()
                    f = a.get_forces().copy()
                x = self.atoms.get_positions() - self.atoms.get_center_of_mass()
                r = np.linalg.norm(x, axis=1) + 1e-12
                out = r > self.radius
                if out.any():
                    d = r[out] - self.radius
                    e += 0.5 * self.k * np.sum(d * d)
                    f[out] -= (self.k * d / r[out])[:, None] * x[out]
                self.results = {"energy": e, "forces": f}

        _beaker_cls = Beaker
    return _beaker_cls(base, radius, lock, k)


_base = {}
_base_lock = threading.Lock()
_model_lock = threading.Lock()


def method() -> str:
    return os.environ.get("QUMOL_COOK_METHOD", "ani1xnr")


def base_calculator(name: str | None = None):
    """The cook potential, loaded once and shared (calls are serialized by the Beaker lock)."""
    name = name or method()
    with _base_lock:
        if name not in _base:
            if name == "ani1xnr":
                os.environ.setdefault("TORCHANI_NO_WARN_EXTENSIONS", "1")
                import torchani

                _base[name] = torchani.models.ANI1xnr().ase()
            elif name == "uma":
                from .calculators import get_calculator

                _base[name] = get_calculator("uma").calc  # already serialized
            elif name == "emt":
                from ase.calculators.emt import EMT

                _base[name] = EMT()
            else:
                raise ValueError(f"Unknown QUMOL_COOK_METHOD {name!r}: use ani1xnr, uma or emt")
        return _base[name]


def available() -> bool:
    try:
        if method() == "ani1xnr":
            import torchani  # noqa: F401
        elif method() == "uma":
            import fairchem.core  # noqa: F401
        import ase  # noqa: F401
        return True
    except ImportError:
        return False


# ------------------------------------------------------------------ geometry helpers


def scatter(symbols, radius: float, min_dist: float, rng) -> np.ndarray:
    pos = []
    for _ in symbols:
        for _try in range(10000):
            p = rng.uniform(-radius, radius, 3)
            if np.linalg.norm(p) <= radius and all(np.linalg.norm(p - q) >= min_dist for q in pos):
                pos.append(p)
                break
        else:
            raise ValueError("The beaker is too small for these atoms")
    return np.array(pos)


def fragments(symbols, coords, scale: float = 1.2) -> list[list[int]]:
    """Connected components, bonded within ``scale`` x the sum of covalent radii; largest first."""
    x = np.asarray(coords, dtype=float)
    r = np.array([ELEMENTS[s]["r"] for s in symbols])
    n = len(symbols)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i in range(n):
        for j in range(i + 1, n):
            if np.linalg.norm(x[i] - x[j]) < scale * (r[i] + r[j]):
                parent[find(i)] = find(j)
    groups = {}
    for a in range(n):
        groups.setdefault(find(a), []).append(a)
    return sorted(groups.values(), key=lambda g: (-len(g), g[0]))


def pot_summary(symbols, coords) -> str:
    """'C3O + 2×CO' for the readout."""
    from collections import Counter

    c = Counter(hill_formula([symbols[k] for k in g]) for g in fragments(symbols, coords))
    return " + ".join(f"{n}×{f}" if n > 1 else f for f, n in c.most_common())


# Bond length / (sum of covalent radii) below which a bond is read as triple or double.
TRIPLE, DOUBLE = 0.82, 0.91


def saturate(symbols, coords, seed: int = 0):
    """Bond orders from bond lengths (shortest bonds first, within valence), then H on every
    free valence, placed away from the neighbors. Returns (symbols, coords, bonds)."""
    syms = list(symbols)
    x = [np.asarray(p, dtype=float) for p in coords]
    n = len(syms)
    r = [ELEMENTS[s]["r"] for s in syms]
    pairs = sorted((np.linalg.norm(x[i] - x[j]) / (r[i] + r[j]), i, j)
                   for i in range(n) for j in range(i + 1, n)
                   if np.linalg.norm(x[i] - x[j]) < 1.2 * (r[i] + r[j]))
    cap = [max_bonds(s) for s in syms]
    used = [0] * n
    bonds = []
    for _ratio, i, j in pairs:  # every bond is single first; if crowded, the shortest win
        if used[i] < cap[i] and used[j] < cap[j]:
            bonds.append([i, j, 1])
            used[i] += 1
            used[j] += 1
    for b in bonds:  # then short bonds become double or triple while both atoms have valence
        i, j = b[0], b[1]
        ratio = np.linalg.norm(x[i] - x[j]) / (r[i] + r[j])
        want = 3 if ratio < TRIPLE else 2 if ratio < DOUBLE else 1
        vi, vj = ELEMENTS[syms[i]]["val"], ELEMENTS[syms[j]]["val"]
        while b[2] < want and used[i] < vi and used[j] < vj:
            b[2] += 1
            used[i] += 1
            used[j] += 1
    _, deficit = assign_charges(syms, [tuple(b) for b in bonds])
    rng = np.random.default_rng(seed)
    for i in range(n):
        for _ in range(max(0, deficit[i])):
            nb = [x[b[1] if b[0] == i else b[0]] - x[i] for b in bonds if i in b[:2]]
            away = sum(v / np.linalg.norm(v) for v in nb) if nb else None
            best, gap = None, -1.0
            for _try in range(200):  # the direction farthest from everything already there
                d = rng.normal(size=3)
                d /= np.linalg.norm(d)
                if away is not None and len(nb) < 3 and np.dot(d, away) > 0:
                    continue
                p = x[i] + d * (ELEMENTS[syms[i]]["r"] + ELEMENTS["H"]["r"]) * 1.05
                g = min((np.linalg.norm(p - q) for k, q in enumerate(x) if k != i), default=9.9)
                if g > gap:
                    best, gap = p, g
            x.append(best)
            syms.append("H")
            bonds.append([i, len(syms) - 1, 1])
    return syms, np.array(x), [tuple(b) for b in bonds]


def products(symbols, coords) -> list[dict]:
    """Saturated molecules made from the pot, largest first, one per distinct SMILES.
    ``atoms``/``bonds`` are centred for building; ``copies`` has every piece in the pot that
    made this molecule, in pot coordinates: ``idx`` (its pot atoms, in order), then ``atoms``
    (those atoms followed by the added H) and ``bonds``, so the client can sprinkle the H in place."""
    out, seen = [], {}
    groups = [g for g in fragments(symbols, coords) if any(symbols[k] != "H" for k in g)]
    keep = [g for g in groups if len(g) >= 2] or groups[:1]  # lone atoms only if nothing bonded
    for g in keep:
        sub = [symbols[k] for k in g]
        xs = np.asarray(coords, dtype=float)[g]
        syms, x, bonds = saturate(sub, xs)
        c = x[: len(g)].mean(axis=0)
        try:
            mol = validate(syms, x - c, bonds)
        except ChemError:
            continue
        smi = smiles_of(mol)
        key = smi or hill_formula(syms)
        copy = {"idx": list(g), "bonds": [list(b) for b in bonds],
                "atoms": [{"el": s_, "x": round(float(p[0]), 4), "y": round(float(p[1]), 4), "z": round(float(p[2]), 4)}
                          for s_, p in zip(syms, x)]}
        if key in seen:
            seen[key]["copies"].append(copy)
            continue
        prod = {"formula": hill_formula(syms), "smiles": smi, "heavy": sum(s_ != "H" for s_ in sub),
                "atoms": [{"el": s_, "x": float(p[0]), "y": float(p[1]), "z": float(p[2])} for s_, p in zip(syms, x - c)],
                "bonds": [list(b) for b in bonds], "copies": [copy]}
        seen[key] = prod
        out.append(prod)
    return out


# ------------------------------------------------------------------ the cook


def check_recipe(recipe: dict[str, int]) -> list[str]:
    symbols = []
    for el, k in recipe.items():
        if el not in COOK_ELEMENTS:
            raise ValueError(f"{el} can't go in the pot yet (only {', '.join(COOK_ELEMENTS)})")
        if not 0 <= int(k) <= MAX_ATOMS:
            raise ValueError("Too many atoms")
        symbols += [el] * int(k)
    heavy = sum(s != "H" for s in symbols)
    if not 1 <= heavy <= MAX_ATOMS or len(symbols) < MIN_ATOMS:
        raise ValueError(f"Put {MIN_ATOMS} to {MAX_ATOMS} atoms in the pot (not just hydrogen)")
    if len(symbols) - heavy > MAX_H:
        raise ValueError(f"At most {MAX_H} hydrogens")
    return symbols


def check_start(start) -> tuple[list[str], np.ndarray]:
    """Atoms the player dropped in the pot, as ``[(el, x, y, z), ...]``: inside the beaker
    and not on top of each other. Returns the symbols and positions."""
    symbols = [str(a[0]) for a in start]
    recipe: dict[str, int] = {}
    for el in symbols:
        recipe[el] = recipe.get(el, 0) + 1
    check_recipe(recipe)
    x = np.array([[float(v) for v in a[1:4]] for a in start])
    if x.shape != (len(symbols), 3) or not np.isfinite(x).all():
        raise ValueError("Bad atom positions")
    radius = beaker_radius(sum(s != "H" for s in symbols))
    if (np.linalg.norm(x, axis=1) > radius + 0.5).any():
        raise ValueError("An atom fell outside the beaker")
    d = np.linalg.norm(x[:, None] - x[None], axis=-1) + np.eye(len(x)) * 9
    if d.min() < 0.8:
        raise ValueError("Two atoms are on top of each other")
    return symbols, x


def cook(recipe: dict[str, int] | None, temp: float, seed: int = 0, on_event=None, base=None, start=None,
         duration_fs: float = DEFAULT_FS) -> dict:
    """Run one cook from a recipe (atoms scattered at random) or from ``start``, the
    player's own placement ``[(el, x, y, z), ...]``. ``on_event`` gets ``start`` and
    ``frame`` events for streaming."""
    from ase import Atoms, units
    from ase.md.langevin import Langevin
    from ase.md.velocitydistribution import MaxwellBoltzmannDistribution
    from ase.optimize import BFGS

    if start is not None:
        symbols, x0 = check_start(start)
    else:
        symbols, x0 = check_recipe(recipe or {}), None
    temp = float(min(MAX_TEMP, max(MIN_TEMP, temp)))
    n = len(symbols)
    radius = beaker_radius(sum(s != "H" for s in symbols))
    duration_fs = float(min(MAX_FS, max(MIN_FS, duration_fs)))
    dt = DT_FS_H if "H" in symbols else DT_FS
    every = max(1, round(5 / dt))  # a frame about every 5 fs
    rng = np.random.default_rng(seed)
    atoms = Atoms(symbols, positions=x0 if x0 is not None else scatter(symbols, radius, 2.0, rng))
    atoms.info.update({"charge": 0, "spin": 1 if sum(atoms.numbers) % 2 == 0 else 2})
    atoms.calc = beaker(base if base is not None else base_calculator(), radius, _model_lock)

    total = max(3, int(round(duration_fs / dt)))
    edge = max(1, int(round(HEAT * total)))
    steps = [edge, total - 2 * edge, edge]

    def temp_at(k):
        if k < steps[0]:
            return 300 + (temp - 300) * k / max(1, steps[0])
        if k < steps[0] + steps[1]:
            return temp
        return temp + (300 - temp) * (k - steps[0] - steps[1]) / max(1, steps[2])

    emit = on_event or (lambda ev: None)
    emit({"type": "start", "method": method(), "symbols": symbols, "radius": radius, "steps": total,
          "dt_fs": dt, "duration_fs": duration_fs, "temp": temp, "seed": seed,
          "coords": atoms.get_positions().round(3).tolist()})
    t0 = time.perf_counter()
    with _quiet():
        MaxwellBoltzmannDistribution(atoms, temperature_K=300, rng=rng)
        dyn = Langevin(atoms, dt * units.fs, temperature_K=300, friction=FRICTION / units.fs, fixcm=False,
                       rng=np.random.default_rng(seed + 1))
    first_bond, pieces0 = None, len(fragments(symbols, atoms.get_positions()))
    for k in range(total):
        dyn.set_temperature(temperature_K=temp_at(k))
        dyn.run(1)
        if (k + 1) % every == 0 or k == total - 1:
            x = atoms.get_positions() - atoms.get_center_of_mass()
            if first_bond is None and len(fragments(symbols, x)) < pieces0:
                first_bond = round((k + 1) * dt, 1)
            emit({"type": "frame", "coords": x.round(3).tolist(), "t_ps": round((k + 1) * dt / 1000, 4),
                  "t_fs": round((k + 1) * dt, 1),
                  "temp_set": round(temp_at(k)), "temp_kin": round(float(atoms.get_temperature())),
                  "energy": float(atoms.get_potential_energy()), "pot": pot_summary(symbols, x)})
    opt = BFGS(atoms, logfile=None, maxstep=0.2)
    opt.run(fmax=0.05, steps=200)
    x = atoms.get_positions() - atoms.get_center_of_mass()
    emit({"type": "frame", "coords": x.round(3).tolist(), "t_ps": round(total * dt / 1000, 4), "t_fs": round(total * dt, 1),
          "temp_set": 0, "temp_kin": 0, "energy": float(atoms.get_potential_energy()),
          "pot": pot_summary(symbols, x), "quench": True})
    return {"method": method(), "symbols": symbols, "temp": temp, "seed": seed, "radius": radius, "duration_fs": duration_fs,
            "coords": x.round(4).tolist(), "pot": pot_summary(symbols, x), "first_bond_fs": first_bond,
            "seconds": round(time.perf_counter() - t0, 2), "products": products(symbols, x)}


class _quiet:
    """ASE warns about deprecated Langevin options on every cook; keep the server log clean."""

    def __enter__(self):
        import warnings

        self._w = warnings.catch_warnings()
        self._w.__enter__()
        warnings.simplefilter("ignore")

    def __exit__(self, *exc):
        self._w.__exit__(*exc)
