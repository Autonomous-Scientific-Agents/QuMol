# QuMol

> You played with building blocks as a kid. Now play with the universe's: **atoms**.

QuMol is a 3D molecule-building game that runs in the browser on phones and desktops. Players build molecules atom by atom and submit them. Each submission is optimised and checked for stability, then scored. The biggest rewards go to small, stable molecules that are new to QuMol and not found in PubChem. Every submission adds to a growing molecular dataset.

## Status

This is an early prototype, with the whole game in one file at `web/index.html`.

- 3D builder with C, N, O, S, F, Cl and H. It has Add, Bond, Move and Delete modes, plus Undo, an auto-hydrogen button and Clear.
- Touch controls: one finger rotates and pinching zooms. Mouse works too.
- On submit, the structure is optimised with an animation, checked for saddle points and stability, then scored.
- Sound effects, particle bursts, vibration and an animated score card.
- SMILES come from RDKit.js, and novelty is checked live against PubChem.

### Known limitations

- Energies come from a **toy force field** (harmonic bonds and angles plus soft repulsion, with no torsions). It is a placeholder for a real ML potential such as UMA.
- Scores, history and records are stored **per device** in localStorage. There is no backend or shared leaderboard yet.
- RDKit.js and three.js load from CDNs, so the first load needs internet.

## Run locally

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000
```

To share it over Tailscale:

```bash
tailscale serve 8000     # devices on your tailnet
tailscale funnel 8000    # anyone with the link
```

## Scoring (v0.1)

| Component | Points |
|---|---|
| Geometry skill: closeness of the submitted geometry to the optimised one | up to 100 |
| Stable structure | +50 |
| Hand-built in the 3D editor | +50 |
| SMILES new to QuMol | +100 |
| First claim of a molecular formula | +30 |
| New lowest-energy record for a formula | +300 |
| Not in PubChem | +1,000 |
| Size multiplier | × 1/√(heavy atoms) |

## Roadmap

- Backend with FastAPI and SQLite. It will hold players (nickname plus token), geometries keyed by their HashMol3D identifier, an expandable table of energy methods and calculations, submissions, and shared leaderboards.
- Real potentials, starting with UMA or another small MLP, with server-side rescoring.
- Transition-state mode.
- 2D drawing, SMILES and XYZ input modes.
- Category leaderboards.
- GDB-13 novelty bonus.
- Optional Google sign-in.
