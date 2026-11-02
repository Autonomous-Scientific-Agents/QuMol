"""Chemistry helpers: elements, validation, formulas, HashMol3D identifiers, SMILES."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

import numpy as np
from hashmol3d import descriptor_geometry, hash_molecule

# Elements allowed in the game for now (organic, drug-like).
#   val      usual valence (hydrogens are added up to this)
#   neutral  bond counts the atom can have without a charge (S can be 2-, 4- or 6-valent)
#   plus     bond count reachable with a + formal charge (O⁺ in C≡O, N⁺ in nitro groups)
ELEMENTS: dict[str, dict] = {
    "H": {"z": 1, "r": 0.31, "val": 1, "neutral": (1,), "plus": None},
    "C": {"z": 6, "r": 0.76, "val": 4, "neutral": (4,), "plus": None},
    "N": {"z": 7, "r": 0.71, "val": 3, "neutral": (3,), "plus": 4},
    "O": {"z": 8, "r": 0.66, "val": 2, "neutral": (2,), "plus": 3},
    "F": {"z": 9, "r": 0.57, "val": 1, "neutral": (1,), "plus": None},
    "S": {"z": 16, "r": 1.05, "val": 2, "neutral": (2, 4, 6), "plus": None},
}


def max_bonds(sym: str) -> int:
    e = ELEMENTS[sym]
    return max(e["neutral"] + ((e["plus"],) if e["plus"] else ()))
Z_TO_SYMBOL = {v["z"]: k for k, v in ELEMENTS.items()}

MAX_HEAVY = 10
MAX_ATOMS = 60
MAX_BOND_LENGTH = 4.0  # Å; real bonds are < 2 Å
MAX_RADICALS = 2  # unpaired electrons allowed per molecule


class ChemError(ValueError):
    """Raised for a structure the game cannot accept."""


@dataclass
class Molecule:
    symbols: list[str]
    coords: np.ndarray  # (N, 3) in Å
    bonds: list[tuple[int, int, int]]  # (i, j, order)
    charges: list[int] | None = None  # formal charges (net zero), from assign_charges
    radicals: int = 0  # unpaired electrons (free bonds left on heavy atoms)

    @property
    def multiplicity(self) -> int:
        return self.radicals + 1  # 1 unpaired: doublet; 2: triplet (e.g. carbenes)

    @property
    def numbers(self) -> list[int]:
        return [ELEMENTS[s]["z"] for s in self.symbols]

    @property
    def n_heavy(self) -> int:
        return sum(1 for s in self.symbols if s != "H")

    def neighbors(self, i: int) -> list[int]:
        return [b if a == i else a for a, b, _ in self.bonds if a == i or b == i]


def validate(symbols, coords, bonds) -> Molecule:
    """Check a submitted structure and return it as a Molecule."""
    if not symbols:
        raise ChemError("Empty molecule")
    if len(symbols) > MAX_ATOMS:
        raise ChemError(f"Too many atoms (max {MAX_ATOMS})")
    for s in symbols:
        if s not in ELEMENTS:
            raise ChemError(f"Element {s!r} is not allowed")
    xyz = np.asarray(coords, dtype=float)
    if xyz.shape != (len(symbols), 3) or not np.all(np.isfinite(xyz)):
        raise ChemError("Coordinates must be finite and shaped (N, 3)")
    if np.abs(xyz).max() > 1000:
        raise ChemError("Coordinates are out of range")
    n = len(symbols)
    seen = set()
    clean = []
    for b in bonds:
        a, c, o = int(b[0]), int(b[1]), int(b[2])
        if not (0 <= a < n and 0 <= c < n) or a == c or o not in (1, 2, 3):
            raise ChemError("Invalid bond")
        key = (min(a, c), max(a, c))
        if key in seen:
            raise ChemError("Duplicate bond")
        seen.add(key)
        clean.append((a, c, o))
    mol = Molecule(list(symbols), xyz, clean)
    if mol.n_heavy == 0:
        raise ChemError("Build something with at least one heavy atom")
    if mol.n_heavy > MAX_HEAVY:
        raise ChemError(f"Too many heavy atoms (max {MAX_HEAVY})")
    for i, s in enumerate(symbols):
        used = sum(o for a, c, o in clean if a == i or c == i)
        if used > max_bonds(s):
            raise ChemError(f"Atom {i + 1} ({s}) has too many bonds (max {max_bonds(s)})")
    if not is_connected(mol):
        raise ChemError("Your molecule is in pieces. Connect everything")
    for a, c, _ in clean:
        if np.linalg.norm(xyz[a] - xyz[c]) > MAX_BOND_LENGTH:
            raise ChemError(f"Bond between atoms {a + 1} and {c + 1} is far too long (over {MAX_BOND_LENGTH:g} Å)")
    charges, deficit = assign_charges(mol.symbols, clean, strict=True)
    radicals = sum(d for i, d in enumerate(deficit) if symbols[i] != "H")
    if radicals > MAX_RADICALS:
        raise ChemError(
            f"{radicals} free bonds left. Add hydrogens with H+ (radicals may have at most {MAX_RADICALS} unpaired electrons)")
    mol.charges = charges
    mol.radicals = radicals
    return mol


def assign_charges(symbols, bonds, strict: bool = False):
    """Formal charges for atoms with an extra bond, balanced so the molecule stays neutral.

    An O with 3 bonds or an N with 4 takes a + charge; the nearest atom (by bonds) that is
    one bond short of its usual valence takes the matching − charge. That gives
    carbon monoxide ⁻C≡O⁺ and nitro groups −N⁺(=O)O⁻. Returns (charges, deficit), where
    deficit is how many bonds each atom still lacks (filled with hydrogens).
    With ``strict``, an unbalanced + charge raises ChemError.
    """
    n = len(symbols)
    total = [0] * n
    nbrs = [[] for _ in range(n)]
    for a, b, o in bonds:
        total[a] += o
        total[b] += o
        nbrs[a].append(b)
        nbrs[b].append(a)
    charges = [0] * n
    deficit = [0] * n
    plus = []
    for i, s in enumerate(symbols):
        e = ELEMENTS[s]
        if total[i] > max(e["neutral"]):
            plus.append(i)
        else:
            deficit[i] = min(v for v in e["neutral"] if v >= total[i]) - total[i]
    for i in plus:
        # breadth-first: nearest heavy atom that is one bond short and not yet charged
        seen, frontier, partner = {i}, [i], None
        while frontier and partner is None:
            nxt = []
            for u in frontier:
                for v in nbrs[u]:
                    if v in seen:
                        continue
                    seen.add(v)
                    if symbols[v] != "H" and deficit[v] > 0 and charges[v] == 0:
                        partner = v
                        break
                    nxt.append(v)
                if partner is not None:
                    break
            frontier = nxt
        if partner is None:
            if strict:
                raise ChemError(
                    f"Atom {i + 1} ({symbols[i]}) has {total[i]} bonds, so it needs a + charge, "
                    "but no neighbor has a free bond to take the − charge (like C≡O or a nitro group)")
            continue
        charges[i] = 1
        charges[partner] = -1
        deficit[partner] -= 1
    return charges, deficit


def is_connected(mol: Molecule) -> bool:
    n = len(mol.symbols)
    if n == 0:
        return False
    seen, stack = {0}, [0]
    while stack:
        i = stack.pop()
        for j in mol.neighbors(i):
            if j not in seen:
                seen.add(j)
                stack.append(j)
    return len(seen) == n


def hill_formula(symbols) -> str:
    cnt = Counter(symbols)
    lead = [k for k in ("C", "H") if k in cnt] if "C" in cnt else []  # Hill order: C, H, then A-Z
    order = lead + sorted(k for k in cnt if k not in lead)
    return "".join(k + (str(cnt[k]) if cnt[k] > 1 else "") for k in order)


# ---------------------------------------------------------------- HashMol3D


@dataclass
class GeometryId:
    id: str  # full identifier, e.g. hm3d_v12_p4_H2O_q0m1_b8ad...
    formula: str
    geometry_hash: str
    version: str
    precision: float
    charge: int
    multiplicity: int
    descriptor: str
    std_symbols: list[str]  # standardized (quantized, principal-axes) geometry
    std_coords: np.ndarray


def hash_geometry(symbols, coords, charge: int = 0, multiplicity: int | None = None) -> GeometryId:
    """HashMol3D identifier (library defaults) plus the standardized geometry.

    The frame method's descriptor encodes the molecule in its canonical
    principal-axes frame, so identical structures map to one identifier and one
    standardized geometry (recovered with ``hashmol3d.descriptor_geometry``,
    which re-hashes to the same identifier). If HashMol3D fell back to the
    distance method there are no frame coordinates; the centered input is kept.
    """
    numbers = [ELEMENTS[s]["z"] for s in symbols]
    r = hash_molecule(numbers, np.asarray(coords, dtype=float), charge=charge, multiplicity=multiplicity)
    try:
        zs, std_xyz = descriptor_geometry(r.descriptor)
        std_syms = [Z_TO_SYMBOL[int(z)] for z in zs]
    except ValueError:
        xyz = np.asarray(coords, dtype=float)
        std_syms, std_xyz = list(symbols), np.round(xyz - xyz.mean(axis=0), 6)
    return GeometryId(
        id=r.hash_str, formula=r.formula, geometry_hash=r.geometry_hash, version=r.version,
        precision=r.precision, charge=r.charge, multiplicity=r.multiplicity,
        descriptor=r.descriptor, std_symbols=std_syms, std_coords=np.asarray(std_xyz, dtype=float),
    )


def to_xyz(symbols, coords, comment: str = "") -> str:
    lines = [str(len(symbols)), comment]
    lines += [f"{s:<2} {x: .6f} {y: .6f} {z: .6f}" for s, (x, y, z) in zip(symbols, coords)]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- SMILES (RDKit)


def smiles_of(mol: Molecule, implicit_h: bool = False) -> str | None:
    """Canonical SMILES from the player's atoms and bonds, or None if invalid."""
    try:
        from rdkit import Chem
        from rdkit import RDLogger

        RDLogger.DisableLog("rdApp.*")
    except ImportError:
        return None
    btype = {1: Chem.BondType.SINGLE, 2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE}
    charges = mol.charges or [0] * len(mol.symbols)
    try:
        rw = Chem.RWMol()
        for s, q in zip(mol.symbols, charges):
            atom = Chem.Atom(s)
            atom.SetFormalCharge(int(q))
            atom.SetNoImplicit(not implicit_h)  # complete molecules carry all their H explicitly
            rw.AddAtom(atom)
        for a, b, o in mol.bonds:
            rw.AddBond(a, b, btype[o])
        m = rw.GetMol()
        Chem.SanitizeMol(m)
        m = Chem.RemoveHs(m)
        return Chem.MolToSmiles(m)
    except Exception:
        return None


def smiles_from_graph(symbols, bonds) -> str | None:
    """SMILES for a partial molecule (atoms + bonds only, no coordinates), for live display."""
    n = len(symbols)
    for s_ in symbols:
        if s_ not in ELEMENTS:
            raise ChemError(f"Element {s_!r} is not allowed")
    if sum(1 for s_ in symbols if s_ != "H") > MAX_HEAVY:
        raise ChemError(f"Too many heavy atoms (max {MAX_HEAVY})")
    clean, seen = [], set()
    for a, b, o in bonds:
        if not (0 <= a < n and 0 <= b < n) or a == b or o not in (1, 2, 3):
            raise ChemError("Invalid bond")
        key = (min(a, b), max(a, b))
        if key in seen:
            raise ChemError("Duplicate bond")
        seen.add(key)
        clean.append((int(a), int(b), int(o)))
    for i, s_ in enumerate(symbols):
        if sum(o for a, b, o in clean if i in (a, b)) > max_bonds(s_):
            raise ChemError(f"Atom {i + 1} ({s_}) has too many bonds")
    charges, _ = assign_charges(list(symbols), clean)
    # partial molecules: missing hydrogens are implied, so the display reads naturally
    return smiles_of(Molecule(list(symbols), np.zeros((n, 3)), clean, charges), implicit_h=True)


def inchikey_of(smiles: str | None) -> str | None:
    if not smiles:
        return None
    try:
        from rdkit import Chem

        m = Chem.MolFromSmiles(smiles)
        return Chem.MolToInchiKey(m) if m else None
    except Exception:
        return None


# ---------------------------------------------------------------- sanity


def structure_problem(mol: Molecule, coords: np.ndarray) -> str | None:
    """What broke, in words (None if the structure kept its bonds without collapsing)."""
    x = np.asarray(coords)
    r = {s: ELEMENTS[s]["r"] for s in ELEMENTS}
    factor = {1: 1.0, 2: 0.87, 3: 0.78}

    def name(i):
        return f"{mol.symbols[i]}{i + 1}"

    for a, b, o in mol.bonds:
        r0 = (r[mol.symbols[a]] + r[mol.symbols[b]]) * factor[o]
        d = float(np.linalg.norm(x[a] - x[b]))
        if d > 1.25 * r0:
            return f"bond {name(a)}–{name(b)} stretched to {d:.2f} Å (normal ≈ {r0:.2f} Å)"
        if d < 0.75 * r0:
            return f"bond {name(a)}–{name(b)} squeezed to {d:.2f} Å (normal ≈ {r0:.2f} Å)"
    bonded = {(min(a, b), max(a, b)) for a, b, _ in mol.bonds}
    n = len(mol.symbols)
    for i in range(n):
        for j in range(i + 1, n):
            if (i, j) in bonded or mol.symbols[i] == "H" or mol.symbols[j] == "H":
                continue
            d = float(np.linalg.norm(x[i] - x[j]))
            # an unbonded heavy-atom pair this close: collapsed structure,
            # unless they are 1-3 neighbors sharing an atom
            if d < 1.6 and not set(mol.neighbors(i)) & set(mol.neighbors(j)):
                return f"unbonded atoms {name(i)} and {name(j)} collided ({d:.2f} Å apart)"
    return None


def structure_intact(mol: Molecule, coords: np.ndarray) -> bool:
    """Did the optimized structure keep its bonds without collapsing?"""
    return structure_problem(mol, coords) is None
