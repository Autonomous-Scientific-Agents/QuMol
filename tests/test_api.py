from conftest import ethanol, player


def test_signup_and_recovery(client):
    h, j = player(client)
    assert client.post("/api/players", json={"nickname": "MURAT"}).status_code == 409  # case-insensitive
    assert client.post("/api/players", json={"nickname": "x"}).status_code == 400
    assert client.get("/api/me").status_code == 401
    assert client.get("/api/me", headers=h).json()["nickname"] == "murat"

    bad = client.post("/api/players/recover", json={"nickname": "murat", "recovery_code": "NOPE"})
    assert bad.status_code == 401
    r = client.post("/api/players/recover", json={"nickname": "murat", "recovery_code": j["recovery_code"].lower()})
    assert r.status_code == 200
    new = {"Authorization": "Bearer " + r.json()["token"]}
    assert client.get("/api/me", headers=new).status_code == 200
    assert client.get("/api/me", headers=h).status_code == 401  # old device logged out


def test_submission_scoring_and_storage(client):
    h, _ = player(client)
    r = client.post("/api/submissions", json=ethanol(), headers=h)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["stable"] and j["smiles"] == "CCO" and j["formula"] == "C2H6O"
    labels = [l[0] for l in j["lines"]]
    assert "Hand-built" in labels and "New QuMol SMILES" in labels and "New QuMol formula" in labels
    assert labels[:3] == ["New QuMol formula", "New QuMol SMILES", "Stable"]  # card order
    assert ["Size bonus", 650, "9 atoms: smaller scores more"] in j["lines"]
    assert j["score"] == j["total"] == sum(l[1] for l in j["lines"])
    assert j["optimized_geometry_id"].startswith("hm3d_") and "_C2H6O_q0m1_" in j["optimized_geometry_id"]
    assert len(j["frames"]) > 1 and len(j["coords_opt"]) == 9
    # progress readout and log
    assert len(j["frame_info"]) == len(j["frames"]) and j["frame_info"][0][0] == "input"
    log = j["log"]
    assert log["elapsed_s"] >= 0 and log["steps"] and "toy force field" in log["events"][0]
    assert any(e.startswith("saddle check") for e in log["events"])

    # The same molecule again: stored, but no points.
    again = client.post("/api/submissions", json=ethanol(), headers=h).json()
    assert again["already"] and again["score"] == 0

    # The same structure translated hashes to the same geometry (HashMol3D dedup).
    moved = client.post("/api/submissions", json=ethanol(shift=5.0), headers=h).json()
    assert moved["input_geometry_id"] == j["input_geometry_id"]

    xyz = client.get(f"/api/geometries/{j['optimized_geometry_id']}.xyz").text
    assert xyz.splitlines()[0] == "9"
    stats = client.get("/api/stats").json()
    assert stats["submissions"] == 3 and stats["molecules"] == 1 and stats["geometries"] == 2


def test_input_methods(client):
    h, _ = player(client)
    j = client.post("/api/submissions", json={**ethanol(), "input_method": "smiles"}, headers=h).json()
    geo = next(l for l in j["lines"] if l[0] == "Geometry")
    assert geo[1] == 0 and geo[2] == "auto-generated geometry" and "Hand-built" not in [l[0] for l in j["lines"]]
    h2, _ = player(client, "xyzfan")
    j = client.post("/api/submissions", json={**ethanol(), "input_method": "xyz"}, headers=h2).json()
    labels = [l[0] for l in j["lines"]]
    assert next(l for l in j["lines"] if l[0] == "Geometry")[1] > 0 and "Hand-built" not in labels
    assert "New QuMol SMILES" not in labels  # someone else found it first
    h3, _ = player(client, "learner")
    j = client.post("/api/submissions", json={**ethanol(), "input_method": "example"}, headers=h3).json()
    assert ["Geometry", 0, "example molecule"] in j["lines"] and "Hand-built" not in [l[0] for l in j["lines"]]
    assert client.post("/api/submissions", json={**ethanol(), "input_method": "magic"}, headers=h).status_code == 422


def test_rejects_bad_structures(client):
    h, _ = player(client)
    apart = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "C", "x": 5, "y": 0, "z": 0}], "bonds": []}
    assert client.post("/api/submissions", json=apart, headers=h).status_code == 400
    over = {"atoms": [{"el": "O", "x": 0, "y": 0, "z": 0}] + [{"el": "H", "x": i, "y": 1, "z": 0} for i in range(3)],
            "bonds": [[0, 1, 1], [0, 2, 1], [0, 3, 1]]}
    assert "needs a + charge" in client.post("/api/submissions", json=over, headers=h).json()["detail"]
    metal = {"atoms": [{"el": "Fe", "x": 0, "y": 0, "z": 0}], "bonds": []}
    assert client.post("/api/submissions", json=metal, headers=h).status_code == 400
    huge = {"atoms": [{"el": "C", "x": 1.5 * i, "y": 0, "z": 0} for i in range(31)],
            "bonds": [[i, i + 1, 1] for i in range(30)]}
    assert "heavy atoms" in client.post("/api/submissions", json=huge, headers=h).json()["detail"]


def test_leaderboards(client):
    h1, _ = player(client, "alice")
    h2, _ = player(client, "bob")
    client.post("/api/submissions", json=ethanol(), headers=h1)
    client.post("/api/submissions", json={**ethanol(), "input_method": "xyz"}, headers=h2)
    cats = client.get("/api/leaderboards").json()
    for cat in cats:
        r = client.get(f"/api/leaderboard/{cat}")
        assert r.status_code == 200, (cat, r.text)
    overall = client.get("/api/leaderboard/overall").json()["rows"]
    assert overall[0]["nickname"] == "alice"
    assert client.get("/api/leaderboard/xyz").json()["rows"][0]["nickname"] == "bob"
    assert client.get("/api/leaderboard/nope").status_code == 404
    assert client.get("/").status_code == 200  # serves the game


def test_live_smiles(client):
    eth = ethanol()
    r = client.post("/api/smiles", json={"atoms": [{"el": a["el"]} for a in eth["atoms"]], "bonds": eth["bonds"]})
    assert r.json()["smiles"] == "CCO"
    # partial molecule: missing hydrogens are implied
    assert client.post("/api/smiles", json={"atoms": [{"el": "C"}, {"el": "O"}], "bonds": [[0, 1, 2]]}).json()["smiles"] == "C=O"
    assert client.post("/api/smiles", json={"atoms": [{"el": "Xe"}]}).status_code == 400
    assert client.post("/api/smiles", json={"atoms": [{"el": "C"}], "bonds": [[0, 5, 1]]}).status_code == 400


def test_charges_and_radicals_scoring(client):
    h, _ = player(client)
    co = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "O", "x": 1.13, "y": 0, "z": 0}], "bonds": [[0, 1, 3]]}
    j = client.post("/api/submissions", json=co, headers=h).json()
    labels = [l[0] for l in j["lines"]]
    assert j["smiles"] == "[C-]#[O+]" and "Formal charges" in labels and ["New QuMol formula", 1000, None] in j["lines"]
    assert ["Size bonus", 1000, "2 atoms: smaller scores more"] in j["lines"]
    assert "_q0m1_" in j["optimized_geometry_id"]
    methyl = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "H", "x": 1.08, "y": 0, "z": 0},
                        {"el": "H", "x": -0.54, "y": 0.94, "z": 0}, {"el": "H", "x": -0.54, "y": -0.94, "z": 0}],
              "bonds": [[0, 1, 1], [0, 2, 1], [0, 3, 1]]}
    j = client.post("/api/submissions", json=methyl, headers=h).json()
    assert j["smiles"] == "[CH3]" and "_q0m2_" in j["optimized_geometry_id"]
    assert ["Radical", 0, "1 unpaired electron"] in j["lines"]


def test_local_pubchem_table(client, tmp_path, monkeypatch):
    import sqlite3

    path = tmp_path / "pubchem.sqlite"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE compounds (cid INTEGER PRIMARY KEY, inchikey TEXT, key14 TEXT, heavy INTEGER, title TEXT);
        INSERT INTO compounds VALUES (702, 'LFQSCWFLJHTTHZ-UHFFFAOYSA-N', 'LFQSCWFLJHTTHZ', 3, 'Ethanol');
        INSERT INTO compounds VALUES (107689, 'JVTAAEKCZFNVCJ-REOHCLBHSA-N', 'JVTAAEKCZFNVCJ', 6, 'L-lactic acid');
    """)
    con.commit()
    con.close()
    monkeypatch.setenv("QUMOL_PUBCHEM_DB", str(path))
    h, _ = player(client)
    j = client.post("/api/submissions", json=ethanol(), headers=h).json()
    assert j["pubchem"] == {"known": True, "cid": 702, "name": "Ethanol",
                            "url": "https://pubchem.ncbi.nlm.nih.gov/compound/702"}
    assert not any(l[0] == "In PubChem" for l in j["lines"])  # shown in the card header instead
    assert not j["discovery"]
    # not in the table (and the web check is off in tests): counts as new
    co = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "O", "x": 1.13, "y": 0, "z": 0}], "bonds": [[0, 1, 3]]}
    j = client.post("/api/submissions", json=co, headers=h).json()
    assert ["Not in PubChem", 1000, "possibly new to science"] in j["lines"] and j["discovery"]
    # stereo variant only in the table: matched on the connectivity block of the InChIKey
    from qumol import pubchem
    assert pubchem.lookup_local("JVTAAEKCZFNVCJ-UHFFFAOYSA-N")[:2] == (True, 107689)


def test_broken_optimization_is_reported(client, monkeypatch):
    """If the optimizer tears the molecule apart, say so instead of scoring it as a molecule."""
    import numpy as np

    from qumol import scoring
    from qumol.calculators import OptResult, get_calculator

    real = get_calculator("toyff")

    class Exploding:
        name, version, kind, energy_unit, skill_scale = real.name, real.version, real.kind, real.energy_unit, 2.0

        def params(self):
            return real.params()

        def optimize(self, mol, seed=0):
            x = np.array(mol.coords, dtype=float)
            y = x.copy()
            y[0] += 6.0  # fling the first atom away
            return OptResult(e_input=10.0, e_opt=-5.0, coords_input=x, coords_opt=y, fmax=0.01,
                             converged=True, saddle=False, n_steps=12, frames=[x, y])

    monkeypatch.setattr(scoring, "get_calculator", lambda method=None: Exploding())
    h, _ = player(client)
    j = client.post("/api/submissions", json=ethanol(), headers=h).json()
    assert j["opt_status"] == "broken" and not j["stable"] and "too far from a stable minimum" in j["warning"]
    labels = [l[0] for l in j["lines"]]
    assert "Optimization failed" in labels and "New QuMol SMILES" not in labels and "New QuMol formula" not in labels
    assert "Size bonus" not in labels
    assert any("stretched" in e for e in j["log"]["events"])  # says which bond broke
    # a failed build earns nothing, so resubmitting it can't farm points
    assert j["score"] == 0
    again = client.post("/api/submissions", json=ethanol(), headers=h).json()
    assert again["score"] == 0 and again["total"] == 0


def test_formula_novelty_is_across_methods(client, monkeypatch):
    """Switching to a new energy method doesn't make an already-built formula new again."""
    from qumol import scoring
    from qumol.calculators.toyff import ToyFF

    h, _ = player(client)
    assert ["New QuMol formula", 1000, None] in client.post("/api/submissions", json=ethanol(), headers=h).json()["lines"]

    class NewMethod(ToyFF):
        version = "2"

    new = NewMethod()
    monkeypatch.setattr(scoring, "get_calculator", lambda method=None: new)
    other, _ = player(client, "eve")
    labels = [l[0] for l in client.post("/api/submissions", json=ethanol(), headers=other).json()["lines"]]
    assert "New QuMol formula" not in labels and "Formula record" not in labels


def test_size_bonus():
    from qumol.scoring import size_bonus
    assert [size_bonus(n) for n in (1, 2, 3, 9, 21, 22, 60)] == [1000, 1000, 950, 650, 50, 0, 0]


def test_discovery_claimed_after_pubchem_outage(client, monkeypatch):
    """If the online check failed the first time, a resubmission can still earn the bonus, once."""
    from qumol import pubchem

    h, _ = player(client)
    state = {"known": None}
    monkeypatch.setattr(pubchem, "lookup", lambda con, smiles, inchikey, use_web=True:
                        {"known": state["known"], "cid": None, "name": None, "url": None})
    first = client.post("/api/submissions", json=ethanol(), headers=h).json()
    assert not first["discovery"] and "Not in PubChem" not in [l[0] for l in first["lines"]]

    state["known"] = False  # PubChem is back: not found
    late = client.post("/api/submissions", json=ethanol(), headers=h).json()
    assert late["already"] and late["discovery"]
    assert [l[0] for l in late["lines"]] == ["Already collected", "Not in PubChem"] and late["score"] == 1000

    again = client.post("/api/submissions", json=ethanol(), headers=h).json()
    assert again["already"] and not again["discovery"] and again["score"] == 0
