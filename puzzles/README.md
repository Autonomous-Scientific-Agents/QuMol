# Puzzle reference structures

## SE100 semi-experimental equilibrium geometries

`se100_geometries.json` holds 80 molecules from the SE100 database (those made only of
H, C, N, O, S, F, neutral), from:

> G. Ceselin, V. Barone, N. Tasinato, "Accurate Biomolecular Structures by the Nano-LEGO
> Approach: Pick the Bricks and Build Your Geometry", *J. Chem. Theory Comput.* **17**,
> 7290–7311 (2021). doi:[10.1021/acs.jctc.1c00788](https://doi.org/10.1021/acs.jctc.1c00788)

The article and its Supporting Information are published under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This folder is an adaptation:

- `se100_params.txt`: the SE column of Table S1 (bond lengths, angles, dihedrals),
  copied as printed.
- The paper gives internal coordinates only. `scripts/build_se_geometries.py` fits
  Cartesian coordinates to every printed parameter (max deviation 2×10⁻⁵ Å, 0.005°) and
  cross-checks each structure with GFN2-xTB.
- Changes from the printed tables, listed per molecule in each entry's `notes`:
  misprinted atom labels corrected, conformer-defining dihedrals that the SI leaves
  implicit (for example s-trans), one dihedral read as its supplement (dimethyl
  sulfide), one unreadable dihedral skipped (diallyl disulfide).

Regenerate with `python3 scripts/build_se_geometries.py` (needs rdkit, scipy, ase,
tblite).

## CCCBDB

Experimental geometries from NIST's CCCBDB (SRD 101) are not stored here: NIST
Standard Reference Data is copyrighted ("all rights reserved").
