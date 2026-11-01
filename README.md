# QuMol

> You played with building blocks as a kid. Now play with the universe's: **atoms**.

QuMol is a 3D molecule-building game that runs in the browser on phones and desktops. Players build molecules atom by atom and submit them. Each submission is optimised and checked for stability, then scored. The biggest rewards go to small, stable molecules that are new to QuMol and not found in PubChem. Every submission adds to a growing molecular dataset.

## In the game

- **3D builder** with H, C, N, O, S and F, plus Add, Bond, Move and Delete modes, Undo, H+ (saturate with hydrogens) and Clear. Every button has a hover tooltip.
- **Quick placement:** clicking an element button drops an atom. The first goes at the centre, the second 1 Å away, and later ones 1 Å from the newest atom that still has a free bond, in a VSEPR-like direction, never closer than 0.95 Å to anything. If every atom is saturated, the new atom goes into open space beside the molecule. Bonds are perceived from distance (within 1.2× the covalent radii, respecting valence, and never closing a 3-ring with a bond just made).
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
- **XYZ panel**: the live formula, SMILES and XYZ coordinates as you build. Editing the coordinates changes the molecule. Adding or removing lines adds or removes atoms, and bonds are then guessed from distances. It can be turned off and remembers your choice.
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
- **Abuse limits:** these are per player and per IP, and can be changed with environment variables in `qumol/app.py`.
  - Sign-ups: 20 per IP per hour.
  - Recovery attempts: 10 per IP per hour, and 5 per IP per nickname.
  - Submissions: 20 per minute and 1,000 per day per player; 40 per minute and 3,000 per day per IP.
  - Reads: 120 per minute per IP.

  Exceeding a limit returns `429` with `Retry-After`.
- **Compute protection:**
  - At most 2 optimisations run at once (`QUMOL_WORKERS`), and extra requests get a quick `503`; the game retries automatically.
  - Each player can have only one submission in flight.
  - Bonds longer than 4 Å are rejected.
  - Health checks stay responsive under load. In a stress test with 55 concurrent worst-case submissions, health checks answered in under 0.05 s.
- **Storage:**
  - Request bodies are capped at 256 KB.
  - Molecules are capped at 10 heavy atoms (60 atoms in total).
  - New data is refused when the disk has less than 1 GB free (`QUMOL_MIN_FREE_MB`).
  - Leaderboards and stats are cached for 30 s.
- **Web:**
  - A strict Content-Security-Policy with no inline or third-party scripts. SMILES are computed on the server, so the page needs no `eval`.
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
| New molecular formula (first time anyone builds it) | +1,000 |
| Formal charges (⁻C≡O⁺, nitro groups, …) | +50 |
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
