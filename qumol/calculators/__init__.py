"""Pluggable energy methods.

Every calculator is stored as a row in the ``methods`` table (name + version),
and every result as a row in ``calculations``. Adding a better potential later
means registering a new calculator here: old results stay, new ones are added
beside them, and submissions can be rescored per method.

Pick the active method with the environment variable ``QUMOL_METHOD``
(default ``toyff``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import numpy as np

from ..chem import Molecule


@dataclass
class OptResult:
    e_input: float  # energy of the submitted skeleton (hydrogens tidied)
    e_opt: float  # energy after optimisation
    coords_input: np.ndarray  # the hydrogen-tidied input that was scored
    coords_opt: np.ndarray
    fmax: float
    converged: bool
    saddle: bool  # a small kick lowered the energy: it had stopped on a saddle point
    n_steps: int
    frames: list[np.ndarray] = field(default_factory=list)  # optimisation trajectory


class Calculator:
    name: str = "base"
    version: str = "0"
    kind: str = "force-field"  # or "mlip", "qm"
    energy_unit: str = "kcal/mol"
    # Energy drop per atom at which the geometry-skill score falls to 1/e of max.
    skill_scale: float = 2.0
    needs_bonds: bool = False

    def params(self) -> dict:
        return {}

    def optimize(self, mol: Molecule, seed: int = 0) -> OptResult:  # pragma: no cover
        raise NotImplementedError


_REGISTRY: dict[str, callable] = {}
_CACHE: dict[str, Calculator] = {}


def register(key: str):
    def deco(factory):
        _REGISTRY[key] = factory
        return factory

    return deco


def available() -> list[str]:
    return sorted(_REGISTRY)


def get_calculator(key: str | None = None) -> Calculator:
    key = key or os.environ.get("QUMOL_METHOD", "toyff")
    if key not in _REGISTRY:
        raise KeyError(f"Unknown method {key!r}; available: {available()}")
    if key not in _CACHE:
        _CACHE[key] = _REGISTRY[key]()
    return _CACHE[key]


def subsample(frames: list[np.ndarray], n: int = 60) -> list[np.ndarray]:
    if len(frames) <= n:
        return frames
    idx = np.linspace(0, len(frames) - 1, n).round().astype(int)
    return [frames[i] for i in idx]


# Register built-in calculators.
from . import toyff  # noqa: E402,F401
from . import ase_calc  # noqa: E402,F401
