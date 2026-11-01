import numpy as np
import pytest

from qumol.calculators import get_calculator
from qumol.chem import ChemError, hash_geometry, smiles_of, structure_intact, validate


def water(theta=0.0):
    c, s = np.cos(theta), np.sin(theta)
    rot = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    xyz = np.array([[0, 0, 0], [0.9572, 0, 0], [-0.24, 0.9266, 0]]) @ rot.T + [1, 2, 3]
    return validate(["O", "H", "H"], xyz, [(0, 1, 1), (0, 2, 1)])


def test_hash_is_invariant_and_gives_standard_geometry():
    a = hash_geometry(water().symbols, water().coords)
    b = hash_geometry(water(0.7).symbols, water(0.7).coords)
    assert a.id == b.id and a.id.startswith("H2Oq0m1-")
    assert np.allclose(a.std_coords, b.std_coords)
    # standardized geometry keeps the bond lengths
    o = a.std_symbols.index("O")
    d = sorted(np.linalg.norm(a.std_coords[i] - a.std_coords[o]) for i in range(3) if i != o)
    assert d[0] == pytest.approx(0.9572, abs=2e-4)


def test_smiles_and_validation():
    assert smiles_of(water()) == "O"
    with pytest.raises(ChemError):
        validate(["O", "H"], [[0, 0, 0]], [])


def test_toyff_relaxes_water():
    calc = get_calculator("toyff")
    res = calc.optimize(water())
    assert res.converged and res.e_opt < 1e-3
    x = res.coords_opt
    assert np.linalg.norm(x[1] - x[0]) == pytest.approx(0.97, abs=1e-3)
    v1, v2 = x[1] - x[0], x[2] - x[0]
    ang = np.degrees(np.arccos(v1 @ v2 / np.linalg.norm(v1) / np.linalg.norm(v2)))
    assert ang == pytest.approx(109.47, abs=0.2)
    assert structure_intact(water(), x)


def test_toyff_gradient_matches_finite_differences():
    calc = get_calculator("toyff")
    mol = water()
    calc.build(mol)
    x = mol.coords + 0.05
    _, g = calc.energy_grad(x.copy())
    num = np.zeros_like(x)
    h = 1e-6
    for i in range(x.shape[0]):
        for k in range(3):
            xp, xm = x.copy(), x.copy()
            xp[i, k] += h
            xm[i, k] -= h
            num[i, k] = (calc.energy_grad(xp)[0] - calc.energy_grad(xm)[0]) / (2 * h)
    assert np.allclose(g, num, atol=1e-5)


def test_ase_adapter_runs_with_emt():
    pytest.importorskip("ase")
    calc = get_calculator("emt")
    res = calc.optimize(water())
    assert res.e_opt <= res.e_input + 1e-9
    assert len(res.frames) >= 2
