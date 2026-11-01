# QuMol

> You played with building blocks as a kid. Now play with the universe's: **atoms**.

QuMol is a 3D molecule-building game that runs in the browser on phones and desktops. Players build molecules atom by atom and submit them. Each submission is optimised and checked for stability, then scored. The biggest rewards go to small, stable molecules that are new to QuMol and not found in PubChem. Every submission adds to a growing molecular dataset.

## In the game

- **3D builder** with H, C, N, O, S and F, plus Add, Bond, Move and Delete modes, Undo, H+ (saturate with hydrogens) and Clear. Every button has a hover tooltip.
- **🎓 Learn**:
  - **Elements**: animated Lewis dots, bonds vs. lone pairs, valence electrons, shapes, bond lengths and a fun fact for each element.
  - **Bonds & shapes**: tetrahedral, pyramidal, bent, trigonal planar, linear, single/double/triple bonds and rings. Each has a *Show me* button that loads an example into the 3D view.
  - **Quiz**: 12 questions with explanations and a streak counter.
- **XYZ panel**: the live formula, SMILES and XYZ coordinates as you build. Editing the coordinates changes the molecule. Adding or removing lines adds or removes atoms, and bonds are then guessed from distances. It can be turned off and remembers your choice.
- **Fair scoring by input method**: a molecule loaded from Learn is `example` (no geometry or hand-built points). Coordinates edited in the XYZ panel make it `xyz` (geometry points, but no hand-built bonus). Clear resets it to `hand`.

## Quick start (game + server)

```bash
pip install -r requirements.txt
uvicorn qumol.app:app --host 0.0.0.0 --port 8000
# open http://localhost:8000
```

Share it over Tailscale:

```bash
tailscale serve 8000     # devices on your tailnet
tailscale funnel 8000    # anyone with the link
```

The database is a single SQLite file, `qumol.db`, in the working directory. Set `QUMOL_DB` to put it somewhere else, and back it up by copying the file.

If you open `web/index.html` without the server, the game runs in **offline mode**: scoring is done in the browser and saved only on that device.

## Deploy on a server (systemd + Tailscale)

On an Ubuntu or Debian machine with Tailscale installed, run:

```bash
curl -fsSL https://raw.githubusercontent.com/Autonomous-Scientific-Agents/QuMol/main/deploy/install.sh | bash                    # tailnet only
curl -fsSL https://raw.githubusercontent.com/Autonomous-Scientific-Agents/QuMol/main/deploy/install.sh | TAILSCALE=funnel bash   # public link
```

The script:

1. Clones or updates the code into `~/qumol` and creates a virtualenv.
2. Installs a `qumol` systemd service listening on `127.0.0.1:8010`.
3. Stores the database in `~/qumol/data/qumol.db`.
4. Publishes the game over Tailscale HTTPS on port 8443, so nothing you already serve on 443 is touched.

Re-run it to update. Options: `APP_DIR`, `PORT`, `METHOD=uma`, `TAILSCALE=serve|funnel|off`, `TS_PORT`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `QUMOL_DB` | `qumol.db` | SQLite database path |
| `QUMOL_METHOD` | `toyff` | Energy method: `toyff`, `uma`, or `emt` (EMT is for testing only) |
| `QUMOL_UMA_MODEL` | `uma-s-1p1` | UMA checkpoint (needs `fairchem-core` and access to the weights) |
| `QUMOL_DEVICE` | `cpu` | Device for ML potentials |
| `QUMOL_PUBCHEM` | `1` | Set to `0` to skip live PubChem lookups |

## How it fits together

```
web/index.html          the game: three.js builder, effects, sign-up, leaderboards
qumol/app.py            FastAPI: players, submissions, leaderboards, stats, serves the game
qumol/scoring.py        submission pipeline: optimise → hash → store → score
qumol/chem.py           validation, HashMol3D identifiers, SMILES (RDKit), sanity checks
qumol/calculators/      pluggable energy methods (toy force field; any ASE calculator, e.g. UMA)
qumol/db.py             SQLite schema
scripts/export_dataset.py   dump collected molecules as extended XYZ
```

### Accounts

Players choose a nickname and get a secret login token, kept in their browser, plus a **recovery code** shown once. The recovery code restores the account on a new device. Only hashes of the token and code are stored. A `google_sub` column is reserved for adding Google sign-in later.

### Data model

- **geometries** holds unique 3D structures keyed by their **HashMol3D** identifier (library defaults: frame method, 1e-4 Å grid). Each row also keeps the quantized canonical descriptor and the standardized principal-axes geometry, so the same structure submitted twice, translated or rotated, is stored once.
- **methods** has one row per energy method and version. Adding a new potential means adding a row; old results stay.
- **calculations** holds results of a method on a geometry: a single point on the input, and an optimisation pointing to the optimised geometry. They are unique per geometry, method and kind, so rescoring with a better potential just adds rows.
- **submissions** has one row per player submission. It stores the raw XYZ and bonds exactly as sent, the input and optimised geometry ids, the SMILES and InChIKey, energies, stability, PubChem status, score and score breakdown.
- **pubchem_cache** remembers PubChem lookups.

The server is authoritative: it recomputes every energy itself, so scores can't be faked from the browser.

### API

| Method | Path | |
|---|---|---|
| POST | `/api/players` | `{nickname}` → token and recovery code |
| POST | `/api/players/recover` | `{nickname, recovery_code}` → new token |
| GET | `/api/me` | totals for the signed-in player |
| POST | `/api/submissions` | `{atoms:[{el,x,y,z}], bonds:[[i,j,order]], input_method (hand\|xyz\|example\|smiles\|2d), mode}` |
| GET | `/api/submissions/mine` | the player's history |
| GET | `/api/leaderboards` | the available categories |
| GET | `/api/leaderboard/{category}` | overall, hand, xyz, weekly, small, discoveries, molecules, records |
| GET | `/api/geometries/{id}.xyz` | standardized geometry |
| GET | `/api/stats`, `/api/health` | |

Authenticated calls send `Authorization: Bearer <token>`. Interactive docs are at `/docs`.

## Scoring

| Component | Points |
|---|---|
| Geometry skill, for hand-built and XYZ inputs: closeness of the submitted geometry to the optimum | up to 100 |
| Stable structure | +50 |
| Hand-built in the 3D editor | +50 |
| SMILES new to QuMol | +100 |
| Best geometry yet for an existing SMILES | +100 |
| First claim of a molecular formula | +30 |
| New lowest-energy record for a formula | +300 |
| Not in PubChem | +1,000 |
| Size multiplier | × 1/√(heavy atoms) |

Resubmitting a molecule you already have is stored but scores 0. Point values live in `POINTS` in `qumol/scoring.py`.

## Known limitations

- The default `toyff` method is a **toy force field**: harmonic bonds and angles plus soft repulsion, with no torsions. Every bonding pattern relaxes to an energy near zero, so formula records aren't chemically meaningful until a real potential (`QUMOL_METHOD=uma`) is switched on. The UMA adapter is written but untested.
- There are no vibrational frequencies yet, so stability is judged by convergence, a check that bonds are intact, and a saddle-point "nudge" test.
- There is no rate limiting yet, which is fine for a friends-only phase.
- three.js and RDKit.js load from CDNs.

## Tests

```bash
pip install pytest httpx ase
pytest -q
```

## Roadmap

- Run UMA as the scoring method, and rescore old submissions with it.
- Frequency analysis, and a transition-state mode.
- 2D drawing, SMILES and XYZ input in the UI. The API already accepts them.
- GDB-13 novelty bonus.
- Optional Google sign-in.
