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
    assert a.id == b.id and a.id.startswith("hm3d_") and "_H2O_q0m1_" in a.id
    assert np.allclose(a.std_coords, b.std_coords)
    # standardized geometry keeps the bond lengths
    o = a.std_symbols.index("O")
    d = sorted(np.linalg.norm(a.std_coords[i] - a.std_coords[o]) for i in range(3) if i != o)
    assert d[0] == pytest.approx(0.9572, abs=2e-4)


def test_standard_geometry_rehashes_to_same_id():
    for theta in (0.0, 1.3):
        g = hash_geometry(water(theta).symbols, water(theta).coords)
        again = hash_geometry(g.std_symbols, g.std_coords)
        assert again.id == g.id
        assert np.abs(g.std_coords).max() < 5  # Å, not grid integers


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


def test_formal_charges():
    rng = np.random.default_rng(0)

    def smi(symbols, bonds):
        return smiles_of(validate(symbols, rng.uniform(-1.5, 1.5, (len(symbols), 3)), bonds))

    assert smi(["C", "O"], [(0, 1, 3)]) == "[C-]#[O+]"  # carbon monoxide
    assert smi(["C", "N", "O", "O", "H", "H", "H"],
               [(0, 1, 1), (1, 2, 2), (1, 3, 1), (0, 4, 1), (0, 5, 1), (0, 6, 1)]) == "C[N+](=O)[O-]"
    # radicals: up to 2 unpaired electrons, recorded as the spin multiplicity
    m = validate(["C", "H", "H", "H"], rng.uniform(-1, 1, (4, 3)), [(0, 1, 1), (0, 2, 1), (0, 3, 1)])
    assert smiles_of(m) == "[CH3]" and m.radicals == 1 and m.multiplicity == 2
    assert smi(["N", "O"], [(0, 1, 2)]) == "[N]=O"
    with pytest.raises(ChemError):  # a bare carbon atom has 4 free bonds: too many
        smi(["C"], [])
    with pytest.raises(ChemError):  # O with 3 bonds but nothing to balance the charge
        smi(["O", "H", "H", "H"], [(0, 1, 1), (0, 2, 1), (0, 3, 1)])


def test_ase_path_prerelaxes_with_the_force_field(monkeypatch):
    pytest.importorskip("ase")
    calc = get_calculator("emt")
    stretched = validate(["O", "H", "H"], [[0, 0, 0], [1.3, 0, 0], [-0.3, 1.25, 0]], [(0, 1, 1), (0, 2, 1)])
    res = calc.optimize(stretched)
    assert res.prerelax_steps > 0 and len(res.frames) > 3
    monkeypatch.setenv("QUMOL_PRERELAX", "none")
    assert calc.optimize(stretched).prerelax_steps == 0
