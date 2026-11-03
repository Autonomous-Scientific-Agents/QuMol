# QuMol

> You played with building blocks as a kid. Now play with the universe's: **atoms**.

QuMol is a 3D molecule-building game that runs in the browser on phones and desktops. Players build molecules atom by atom and submit them. Each submission is optimized and checked for stability, then scored. The biggest rewards go to small, stable molecules that are new to QuMol and not found in PubChem. Every submission adds to a growing molecular dataset.

## In the game

- **3D builder** with H, C, N, O, S and F, plus Add, Bond, Move and Delete modes, Undo, H+ (saturate with hydrogens) and Clear. Every button has a hover tooltip.
- **Quick placement:** clicking an element button drops an atom. The first goes at the center, the second 1 Å away, and later ones 1 Å from the newest atom that still has a free bond, in a VSEPR-like direction, never closer than 0.95 Å to anything. If every atom is saturated, the new atom goes into open space beside the molecule. Bonds are perceived from distance (within 1.2× the covalent radii, respecting valence, and never closing a 3- or 4-membered ring with a bond just made).
- **Formal charges and radicals:**
  - Charges are automatic. An O with 3 bonds or an N with 4 becomes **+**, and the nearest atom that is one bond short becomes **−**, so molecules stay neutral: carbon monoxide is `[C-]#[O+]`, nitromethane is `C[N+](=O)[O-]`. S can make 2, 4 or 6 bonds without a charge.
  - If free bonds remain at Build, the player chooses: fill them with H, or build a **radical**. Radicals can have at most 2 unpaired electrons, and the spin multiplicity is stored in the HashMol3D ID (`m2`, `m3`) and passed to UMA.
  - Ions (net charge) are not allowed yet.
- **Size:** up to 10 heavy atoms.
- **Tap a bond** to cycle single → double → triple → single, within each atom's valence. In Delete mode, tapping a bond breaks it. On desktop, bonds highlight on hover.
- **🎓 Learn**:
  - **Elements**: animated Lewis dots, bonds vs. lone pairs, valence electrons, shapes, bond lengths and a fun fact for each element.
  - **Bonds & shapes**: tetrahedral, pyramidal, bent, trigonal planar, linear, single/double/triple bonds and rings. Each has a *Show me* button that loads an example into the 3D view.
  - **Quiz**: 12 questions with explanations and a streak counter.
- **XYZ panel**: the live formula, SMILES and XYZ coordinates as you build. Editing the coordinates changes the molecule. Adding or removing lines adds or removes atoms, and bonds are then guessed from distances (within 1.25× the covalent radii). It can be turned off and remembers your choice.
- **Fair scoring by input method**: a molecule loaded from Learn is `example` (no geometry or hand-built points). Coordinates edited in the XYZ panel make it `xyz` (geometry points, but no hand-built bonus). Clear resets it to `hand`.

## Quick start (game + server)

```bash
pip install -r requirements.txt
bash scripts/fetch_vendor.sh          # pinned, checksum-verified three.js + RDKit.js → web/vendor/
uvicorn qumol.app:app --host 127.0.0.1 --port 8000
# open http://localhost:8000
```

For a real deployment, use the deploy script below. It runs the server as a sandboxed service behind Tailscale.

The database is a single SQLite file, `qumol.db`, in the working directory. Set `QUMOL_DB` to put it somewhere else, and back it up by copying the file.

Without the backend (for example `cd web && python3 -m http.server`), the game runs in **offline mode**: scoring is done in the browser and saved only on that device.

## Deploy on a server (systemd + Tailscale)

On an Ubuntu or Debian machine with Tailscale installed, run:

```bash
curl -fsSL https://raw.githubusercontent.com/Autonomous-Scientific-Agents/QuMol/main/deploy/install.sh | bash                    # tailnet only
curl -fsSL https://raw.githubusercontent.com/Autonomous-Scientific-Agents/QuMol/main/deploy/install.sh | TAILSCALE=funnel bash   # public link
```

The script:

1. Clones or updates the code into `~/qumol`, creates a virtualenv, and downloads the pinned front-end libraries, checking their checksums.
2. Installs a sandboxed `qumol` systemd service listening only on `127.0.0.1:8010`.
3. Stores the database in `~/qumol/data/qumol.db`, readable only by the service.
4. Publishes the game over Tailscale HTTPS on port 8443, so nothing you already serve on 443 is touched.

Re-run it to update. Options: `APP_DIR`, `PORT`, `METHOD=uma`, `TAILSCALE=serve|funnel|off`, `TS_PORT`, and `REF` to pin a tag or commit.

## Security

The game is meant to be safe to expose publicly through Tailscale Funnel.

- **Accounts:** random 256-bit login tokens and 80-bit recovery codes. Only SHA-256 hashes are stored, and codes are compared in constant time. Recovering an account rotates its token.
- **Abuse limits:** these are per player and per IP, and can be changed with the `QUMOL_*` environment variables at the top of `qumol/app.py`.
  - Sign-ups: 20 per IP per hour.
  - Recovery attempts: 10 per IP per hour, and 5 per IP per nickname.
  - Submissions: 20 per minute and 1,000 per day per player; 40 per minute and 3,000 per day per IP.
  - Reads: 120 per minute per IP.

  Exceeding a limit returns `429` with `Retry-After`.
- **Compute protection:**
  - At most 2 optimizations run at once (`QUMOL_WORKERS`), and extra requests get a quick `503`; the game retries automatically.
  - Each player can have only one submission in flight.
  - Bonds longer than 4 Å are rejected.
  - Health checks stay responsive under load. In a stress test with 55 concurrent worst-case submissions, health checks answered in under 0.05 s.
- **Storage:**
  - Request bodies are capped at 256 KB.
  - Molecules are capped at 10 heavy atoms (60 atoms in total).
  - New data is refused when the disk has less than 1 GB free (`QUMOL_MIN_FREE_MB`).
  - Leaderboards and stats are cached for 30 s.
- **Web:**
  - A strict Content-Security-Policy with no inline or third-party scripts. SMILES are computed on the server, so the page needs no `eval`; `'wasm-unsafe-eval'` is allowed only so the RDKit WebAssembly fallback can run if the server stops answering.
  - `nosniff`, `frame-ancestors 'none'`, `no-referrer` and HSTS headers.
  - All user-controlled text is rendered with `textContent`.
  - All SQL is parameterised.
  - Validation errors never echo input back.
  - API docs are off unless `QUMOL_DOCS=1`.
- **Supply chain:** three.js and RDKit.js are pinned and checked against SHA-256 checksums of their npm tarballs, then served from our own origin.
- **Service sandbox:**
  - Runs as a systemd service with `ProtectSystem=strict`.
  - `ProtectHome=tmpfs` hides the rest of your home directory; only the app folder is mounted, read-only, and only `data/` is writable.
  - `NoNewPrivileges`, a system-call filter, no capabilities, and a memory cap.
- **Network:** the server binds to `127.0.0.1`, so it is reachable only through Tailscale. `X-Forwarded-For` is trusted only from localhost.

After deploying, check that `journalctl -u qumol` shows players' real IP addresses. The per-IP limits depend on Tailscale passing them through.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `QUMOL_DB` | `qumol.db` | SQLite database path |
| `QUMOL_METHOD` | `toyff` | Energy method: `toyff`, `uma`, or `emt` (EMT is for testing only) |
| `QUMOL_UMA_MODEL` | `uma-s-1p2p1` | UMA checkpoint, the newest and fastest small model (needs `fairchem-core` and accepted access to the gated weights) |
| `QUMOL_DEVICE` | `cpu` | Device for ML potentials |
| `QUMOL_PRERELAX` | `toyff` | Relax with the toy force field before the ML potential (faster, fewer blow-ups); `none` turns it off |
| `QUMOL_OPTIMIZER` | `BFGS` | ASE optimizer for ML potentials: `BFGS`, `LBFGS` or `FIRE` |
| `QUMOL_UMA_SETTINGS` | `default` | fairchem inference settings (`default` or `batch`; benchmark with `scripts/bench_uma.py`) |
| `QUMOL_WORKERS` | `2` | Optimizations allowed at once. With an ML potential they take turns on the one loaded model |
| `QUMOL_PUBCHEM` | `1` | Set to `0` to skip live PubChem lookups (a local-table miss then counts as not in PubChem) |
| `QUMOL_PUBCHEM_DB` | `pubchem.sqlite` next to the database | Local PubChem lookup table |
| `QUMOL_PUZZLE_FILES` | | Extra puzzle files, `:`-separated (besides any `*.json` in `puzzles/` next to the database) |
| `QUMOL_DOCS` | | Set to `1` to serve the API docs at `/docs` |
| `QUMOL_MAX_BODY` | `262144` | Request body cap in bytes |
| `QUMOL_MIN_FREE_MB` | `1024` | Refuse new data below this much free disk |
| `QUMOL_CACHE_SECONDS` | `30` | How long leaderboards and stats are cached |
| `QUMOL_SIGNUPS_PER_IP_HOUR`, `QUMOL_RECOVERS_PER_IP_HOUR`, `QUMOL_RECOVERS_PER_NICK_HOUR`, `QUMOL_SUBMITS_PER_MIN`, `QUMOL_SUBMITS_PER_DAY`, `QUMOL_SUBMITS_PER_IP_MIN`, `QUMOL_SUBMITS_PER_IP_DAY`, `QUMOL_READS_PER_IP_MIN` | see Security | Abuse limits |

## How it fits together

```
web/index.html          the game page: layout and styles
web/app.js              the game: three.js builder, effects, sign-up, leaderboards, puzzles
qumol/app.py            FastAPI: players, submissions, leaderboards, stats, serves the game
qumol/scoring.py        submission pipeline: optimize → hash → store → score
qumol/chem.py           validation, HashMol3D identifiers, SMILES (RDKit), sanity checks
qumol/calculators/      pluggable energy methods (toy force field; any ASE calculator, e.g. UMA)
qumol/puzzles.py        puzzle mode: reference structures, daily set, RMSD scoring
qumol/pubchem.py        PubChem lookups (local table, then the web API)
qumol/security.py       body limit, security headers, rate limits, compute slots
qumol/db.py             SQLite schema
scripts/export_dataset.py   dump collected molecules as extended XYZ
```

### Accounts

Players choose a nickname and get a secret login token, kept in their browser, plus a **recovery code** shown once. The recovery code restores the account on a new device. Only hashes of the token and code are stored. Players can also give an **optional email** at signup (or later, from their collection) so we can contact them, for example about a discovery. It is never shown publicly or returned to anyone but its owner. A `google_sub` column is reserved for adding Google sign-in later.

### Data model

- **geometries** holds unique 3D structures keyed by their **HashMol3D** identifier (library defaults: frame method, 1e-4 Å grid). Each row also keeps the quantized canonical descriptor and the standardized principal-axes geometry, so the same structure submitted twice, translated or rotated, is stored once.
- **methods** has one row per energy method and version. Adding a new potential means adding a row; old results stay.
- **calculations** holds results of a method on a geometry: a single point on the input, and an optimization pointing to the optimized geometry. They are unique per geometry, method and kind, so rescoring with a better potential just adds rows.
- **submissions** has one row per player submission. It stores the raw XYZ and bonds exactly as sent, the input and optimized geometry ids, the SMILES and InChIKey, energies, stability, PubChem status, score and score breakdown.
- **pubchem_cache** remembers PubChem lookups.

The server is authoritative: it recomputes every energy itself, so scores can't be faked from the browser.

### API

| Method | Path | |
|---|---|---|
| POST | `/api/players` | `{nickname, email?}` → token and recovery code |
| POST | `/api/players/recover` | `{nickname, recovery_code}` → new token |
| PATCH | `/api/me` | `{email}` sets or clears the contact email |
| GET | `/api/puzzles/daily` | today's five puzzles (name, formula, SMILES; your status if signed in) |
| POST | `/api/puzzles/start` | `{puzzle_id?, daily}` → attempt id; starts the clock (no id: random) |
| POST | `/api/puzzles/solve` | `{attempt_id, atoms, bonds}` → not the target (with a tip), or the score, RMSD, outline and biggest differences |
| GET | `/api/me` | totals for the signed-in player |
| POST | `/api/submissions` | `{atoms:[{el,x,y,z}], bonds:[[i,j,order]], input_method (hand\|xyz\|example\|smiles\|2d), mode}` |
| GET | `/api/submissions/mine` | the player's history |
| GET | `/api/leaderboards` | the available categories |
| GET | `/api/leaderboard/{category}` | overall, hand, xyz, weekly, small, discoveries, molecules, records, puzzle_daily, puzzles |
| GET | `/api/geometries/{id}.xyz` | standardized geometry |
| GET | `/api/stats`, `/api/health` | |

Authenticated calls send `Authorization: Bearer <token>`. Interactive docs are at `/docs` when the server runs with `QUMOL_DOCS=1`.

## Scoring

The score card shows the compound's name, formula, SMILES and PubChem link at the top, then the score lines in this order. Each line has a label, points, and a short detail. The score is the sum of the lines.

| Label | Points | Detail |
|---|---|---|
| New QuMol formula | +1,000 | first time anyone builds this molecular formula |
| Formula record | +300 | lowest energy yet for a formula |
| New QuMol SMILES | +100 | first time anyone builds this molecule |
| SMILES record | +100 | lowest energy yet for an existing molecule |
| Stable | +50 | |
| Hand-built | +50 | built in the 3D editor |
| Geometry | up to 100 | ΔE per atom between your geometry and the optimum (hand-built and XYZ only) |
| Saddle point | 0 | the structure rolled off a saddle point to a minimum |
| Radical | 0 | number of unpaired electrons |
| Formal charges | +50 | e.g. ⁻C≡O⁺, nitro groups |
| Not in PubChem | +1,000 | possibly new to science; stable molecules only (later also verified transition states) |
| Size bonus | 1,000 − 50 × (atoms − 2) | all atoms count, hydrogens included: 1,000 for 2 atoms, 50 for 21, nothing from 22 up; stable molecules only (later also verified transition states) |

All points need a **stable** molecule with a readable SMILES. Otherwise the card shows *Optimization failed*, *Not converged* or *Unstable* in place of *Stable*, and every line scores 0. Resubmitting a molecule you already have is stored but scores 0 (*Already collected*). Point values live in `POINTS` in `qumol/scoring.py`.

## Puzzle mode

The 🧩 button opens puzzles: the player gets a molecule's name, formula and SMILES and builds it by hand, against a clock that the server keeps. A **Check** compares the build with the molecule's experimental 3D structure:

- The molecule must be the target (same SMILES as QuMol computes for the reference). A wrong build gets a tip and the clock keeps running.
- **Geometry match:** 1000 × exp(−RMSD / 0.25 Å). The RMSD is over all atoms, after the best symmetry-equivalent atom mapping and the best rotation (mirror images allowed).
- **Speed:** up to 500, decaying with time, more slowly for bigger molecules.
- After solving, the experimental structure appears as a green outline over the player's, with the bond lengths that differ most.
- During a puzzle, examples, XYZ editing and 📏 Measure are off; the player's own work comes back on exit.

Every day (UTC) brings five puzzles from easy to hard, the same for everyone, plus random puzzles from the whole set. Only a player's first solve of each puzzle counts: once in free play, and once each time it is a daily puzzle. On the all-time board each puzzle counts once, with its fastest counted time. Puzzle leaderboards (`puzzle_daily`, `puzzles`) rank by puzzles solved, then by lowest total time.

Reference structures: the 80 SE100 molecules in `puzzles/se100_geometries.json` (see `puzzles/README.md`). Extra sets in the same format, for example a private CCCBDB set kept out of the repo (`scripts/build_cccbdb_puzzles.py`), are loaded from any `*.json` in a `puzzles/` folder next to the database (`data/puzzles/` in a deployment), or from `QUMOL_PUZZLE_FILES=/path/a.json:/path/b.json`. Restart the server after adding one.

### PubChem names and links

QuMol looks molecules up by InChIKey in a local table built from the PubChem dump (`CID-InChI-Key.gz`, `CID-Title.gz`). Only compounds the game can build are kept: at most 10 heavy atoms, only H, C, N, O, S and F, and a single neutral component. Build the table once and copy it next to the database:

```bash
python3 scripts/build_pubchem_index.py --src /path/to/pubchem --out pubchem.sqlite
scp pubchem.sqlite chemgraphserver:~/qumol/data/pubchem.sqlite
```

Without the table, QuMol falls back to PubChem's web API. That fallback gives a yes/no answer and a CID, but no names. A compound missing from the table is double-checked online before the +1,000 bonus is awarded, because the dump may be older than PubChem. If that check fails, PubChem status counts as unknown and no bonus is given.

## Known limitations

- The default `toyff` method is a **toy force field**: harmonic bonds and angles plus soft repulsion, with no torsions. Every bonding pattern relaxes to an energy near zero, so formula records aren't chemically meaningful until a real potential (`QUMOL_METHOD=uma`) is switched on. The UMA adapter is written but untested.
- There are no vibrational frequencies yet, so stability is judged by convergence, a check that bonds are intact, and a saddle-point "nudge" test.

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
