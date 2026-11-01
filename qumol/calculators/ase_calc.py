"""Adapter for any ASE calculator (ML potentials such as UMA, or EMT for testing).

Energies are in eV. The geometry-skill scale of 0.087 eV per atom matches the
toy force field's 2 kcal/mol per atom.
"""

from __future__ import annotations

import os

import numpy as np

from ..chem import Molecule
from . import Calculator, OptResult, register


class ASECalculator(Calculator):
    kind = "mlip"
    energy_unit = "eV"
    skill_scale = 0.087
    needs_bonds = False
    fmax_target = 0.05
    max_steps = 500

    def __init__(self, name: str, version: str, factory, kind: str = "mlip", params: dict | None = None):
        self.name, self.version, self.kind = name, version, kind
        self._factory = factory
        self._calc = None
        self._params = params or {}

    def params(self):
        return {**self._params, "optimizer": "FIRE", "fmax": self.fmax_target}

    @property
    def calc(self):
        if self._calc is None:
            self._calc = self._factory()
        return self._calc

    def _atoms(self, mol: Molecule, coords):
        from ase import Atoms

        at = Atoms(symbols=mol.symbols, positions=np.asarray(coords, dtype=float))
        at.info.update({"charge": 0, "spin": mol.multiplicity})  # UMA's omol task reads these
        at.calc = self.calc
        return at

    def _relax(self, atoms, max_steps, record=None):
        from ase.optimize import FIRE

        opt = FIRE(atoms, logfile=None)
        if record is not None:
            opt.attach(lambda: record.append(atoms.get_positions().copy()), interval=2)
        conv = opt.run(fmax=self.fmax_target, steps=max_steps)
        f = atoms.get_forces()
        return float(atoms.get_potential_energy()), float(np.linalg.norm(f, axis=1).max()), bool(conv), opt.nsteps

    def optimize(self, mol: Molecule, seed: int = 0) -> OptResult:
        from ase.constraints import FixAtoms

        at = self._atoms(mol, mol.coords)
        heavy = [i for i, s in enumerate(mol.symbols) if s != "H"]
        if len(heavy) < len(mol.symbols):
            at.set_constraint(FixAtoms(indices=heavy))
            self._relax(at, 200)
            at.set_constraint()
        coords_input = at.get_positions().copy()
        e_input = float(at.get_potential_energy())
        frames = [coords_input.copy()]
        E, fmax, conv, n = self._relax(at, self.max_steps, record=frames)
        x = at.get_positions().copy()
        frames.append(x.copy())
        rng = np.random.default_rng(seed)
        at2 = self._atoms(mol, x + rng.uniform(-0.03, 0.03, size=x.shape))
        E2, fmax2, conv2, _ = self._relax(at2, self.max_steps)
        saddle = E2 < E - 0.002
        if saddle:
            x, E, fmax, conv = at2.get_positions().copy(), E2, fmax2, conv2
            frames.append(x.copy())
        return OptResult(
            e_input=e_input, e_opt=E, coords_input=coords_input, coords_opt=x,
            fmax=fmax, converged=conv, saddle=bool(saddle), n_steps=int(n), frames=frames,
        )


def _emt():
    from ase.calculators.emt import EMT

    return EMT()


def _uma():
    # Requires: pip install fairchem-core, plus access to the UMA weights on Hugging Face.
    from fairchem.core import FAIRChemCalculator, pretrained_mlip

    model = os.environ.get("QUMOL_UMA_MODEL", "uma-s-1p2p1")
    device = os.environ.get("QUMOL_DEVICE", "cpu")
    predictor = pretrained_mlip.get_predict_unit(model, device=device)
    return FAIRChemCalculator(predictor, task_name="omol")


# EMT is a crude metal potential; it is here only to test the ASE path end to end.
register("emt")(lambda: ASECalculator("emt", "ase", _emt, kind="test"))
register("uma")(
    lambda: ASECalculator(
        "uma", os.environ.get("QUMOL_UMA_MODEL", "uma-s-1p2p1"), _uma, params={"task": "omol"}
    )
)
