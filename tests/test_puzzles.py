import numpy as np

from conftest import player


def test_email_is_optional_private_and_editable(client):
    r = client.post("/api/players", json={"nickname": "ada", "email": " ada@example.org "})
    assert r.status_code == 200
    h = {"Authorization": "Bearer " + r.json()["token"]}
    assert client.get("/api/me", headers=h).json()["email"] == "ada@example.org"
    assert client.post("/api/players", json={"nickname": "bob", "email": "not-an-email"}).status_code == 400
    assert client.post("/api/players", json={"nickname": "cy", "email": ""}).status_code == 200  # empty = none
    assert client.patch("/api/me", json={"email": "ada@lab.gov"}, headers=h).json()["email"] == "ada@lab.gov"
    assert client.patch("/api/me", json={"email": ""}, headers=h).json()["email"] is None
    # never on public boards
    assert "email" not in str(client.get("/api/leaderboard/overall").json())


def _water(scale=1.0, shift=0.0):
    # SE water: r(OH) 0.9573 Å, HOH 104.53°
    t = np.radians(104.53 / 2)
    r = 0.9573 * scale
    atoms = [("O", 0, 0, 0), ("H", r * np.sin(t), r * np.cos(t), 0), ("H", -r * np.sin(t), r * np.cos(t), 0)]
    return [{"el": e, "x": x + shift, "y": y, "z": z} for e, x, y, z in atoms], [[0, 1, 1], [0, 2, 1]]


def test_daily_set_and_solving(client):
    from qumol import puzzles

    h, _ = player(client)
    daily = client.get("/api/puzzles/daily", headers=h).json()
    assert len(daily["puzzles"]) == 5 and daily["total_puzzles"] == 80
    heavy = [p["heavy"] for p in daily["puzzles"]]
    assert heavy == sorted(heavy)  # easy to hard
    assert all(p["smiles"] and "coords" not in p for p in daily["puzzles"])  # name, formula, SMILES; no 3D

    # solve water as a free-play puzzle
    start = client.post("/api/puzzles/start", json={"puzzle_id": "se100-water"}, headers=h).json()
    aid = start["attempt_id"]
    assert start["puzzle"]["formula"] == "H2O" and not start["practice"]

    # wrong molecule: hydrogen peroxide-ish fragment (OH radical) gets a tip, not a score
    wrong = client.post("/api/puzzles/solve", headers=h, json={
        "attempt_id": aid, "atoms": [{"el": "O", "x": 0, "y": 0, "z": 0}, {"el": "H", "x": 0.97, "y": 0, "z": 0}],
        "bonds": [[0, 1, 1]]}).json()
    assert wrong["correct"] is False and wrong["tip"]

    # bare carbon skeleton (> 2 free bonds, forgot H+) also gets the hydrogen tip instead of a 400
    no_h = client.post("/api/puzzles/solve", headers=h, json={
        "attempt_id": aid, "atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "C", "x": 1.5, "y": 0, "z": 0}],
        "bonds": [[0, 1, 1]]})
    assert no_h.status_code == 200 and no_h.json()["correct"] is False and "forget hydrogens" in no_h.json()["tip"]

    atoms, bonds = _water(scale=1.05, shift=4.0)
    ok = client.post("/api/puzzles/solve", headers=h, json={"attempt_id": aid, "atoms": atoms, "bonds": bonds}).json()
    assert ok["correct"] and 0.02 < ok["rmsd"] < 0.06 and ok["tries"] == 3
    assert ok["score"] == sum(l[1] for l in ok["lines"]) > 0
    assert len(ok["ghost"]) == 3 and ok["diffs"][0]["experiment"] == 0.957
    assert client.post("/api/puzzles/solve", headers=h, json={"attempt_id": aid, "atoms": atoms, "bonds": bonds}).status_code == 409

    # a second solve of the same puzzle is practice: no points
    again = client.post("/api/puzzles/start", json={"puzzle_id": "se100-water"}, headers=h).json()
    assert again["practice"]
    r2 = client.post("/api/puzzles/solve", headers=h, json={"attempt_id": again["attempt_id"], "atoms": atoms, "bonds": bonds}).json()
    assert r2["correct"] and r2["score"] == 0 and r2["practice"]

    # other players can't use your attempt
    other, _ = player(client, "eve")
    assert client.post("/api/puzzles/solve", headers=other, json={"attempt_id": aid, "atoms": atoms, "bonds": bonds}).status_code == 404


def test_puzzle_leaderboard_ranks_by_solved_then_time(client, monkeypatch):
    import time

    from qumol import db

    fast, _ = player(client, "fast")
    slow, _ = player(client, "slow")
    many, _ = player(client, "many")
    atoms, bonds = _water()

    def solve(h, pid, took):
        a = client.post("/api/puzzles/start", json={"puzzle_id": pid}, headers=h).json()["attempt_id"]
        con = db.connect()
        with con:  # pretend the puzzle was started `took` seconds ago
            con.execute("UPDATE puzzle_attempts SET started_at=? WHERE id=?", (time.time() - took, a))
        con.close()
        return client.post("/api/puzzles/solve", headers=h, json={"attempt_id": a, "atoms": atoms, "bonds": bonds}).json()

    assert solve(fast, "se100-water", 30)["correct"]
    assert solve(slow, "se100-water", 300)["correct"]
    assert solve(many, "se100-water", 900)["correct"]
    a = client.post("/api/puzzles/start", json={"puzzle_id": "se100-ammonia"}, headers=many).json()["attempt_id"]
    t = np.radians(106.94)
    nh3 = [{"el": "N", "x": 0, "y": 0, "z": 0}] + [
        {"el": "H", "x": float(1.011 * np.cos(k * 2 * np.pi / 3) * 0.94), "y": float(1.011 * np.sin(k * 2 * np.pi / 3) * 0.94),
         "z": -0.37} for k in range(3)]
    r = client.post("/api/puzzles/solve", headers=many, json={"attempt_id": a, "atoms": nh3,
                                                             "bonds": [[0, 1, 1], [0, 2, 1], [0, 3, 1]]}).json()
    assert r["correct"], r
    rows = client.get("/api/leaderboard/puzzles").json()["rows"]
    assert [x["nickname"] for x in rows] == ["many", "fast", "slow"]  # most solved first, then fastest
    assert rows[0]["solved"] == 2 and rows[1]["value"].startswith("1 solved · 0:3")

    # solving water again as a daily puzzle is a counted solve, but it's still one puzzle
    from qumol import puzzles
    monkeypatch.setattr(puzzles, "daily", lambda day=None: [puzzles.load()["se100-water"]])
    a = client.post("/api/puzzles/start", json={"puzzle_id": "se100-water", "daily": True}, headers=fast).json()
    assert not a["practice"]
    r = client.post("/api/puzzles/solve", headers=fast, json={"attempt_id": a["attempt_id"], "atoms": atoms,
                                                             "bonds": bonds}).json()
    assert r["score"] > 0
    from qumol.security import read_cache
    read_cache.clear()
    rows = {x["nickname"]: x for x in client.get("/api/leaderboard/puzzles").json()["rows"]}
    assert rows["fast"]["solved"] == 1
    # and free play after a daily solve is counted too (each is counted once, in either order)
    b = client.post("/api/puzzles/start", json={"puzzle_id": "se100-water"}, headers=slow).json()
    assert b["practice"]


def test_symmetry_aware_rmsd():
    from qumol import puzzles

    p = puzzles.load()["se100-benzene"]
    rng = np.random.default_rng(3)
    perm = rng.permutation(p["n_atoms"])
    inv = np.argsort(perm)
    rot = np.linalg.qr(rng.normal(size=(3, 3)))[0]  # may include a reflection
    x = p["coords"][perm] @ rot + 2.0
    bonds = [(int(inv[a]), int(inv[b]), o) for a, b, o in p["bonds"]]
    res = puzzles.compare(p, [p["symbols"][i] for i in perm], x, bonds)
    assert res["rmsd"] < 1e-6
    assert np.allclose(np.array(res["ghost"]), x, atol=1e-3)  # reference lands on the player's atoms


def test_private_puzzle_folder(client, tmp_path, monkeypatch):
    """Puzzle files dropped in data/puzzles/ (next to the database) are loaded too."""
    import json

    from qumol import db, puzzles

    folder = db.db_path().parent / "puzzles"
    folder.mkdir()
    (folder / "extra_geometries.json").write_text(json.dumps({"molecules": [{
        "name": "Methane", "formula": "CH4", "reference": {"text": "test"},
        "atoms": [["C", 0, 0, 0], ["H", 0.629, 0.629, 0.629], ["H", -0.629, -0.629, 0.629],
                  ["H", -0.629, 0.629, -0.629], ["H", 0.629, -0.629, -0.629]],
        "bonds": [[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1]]}]}))
    puzzles.reset_cache()
    try:
        assert "extra-methane" in puzzles.load()
    finally:
        puzzles.reset_cache()


def test_rmsd_with_many_hydrogen_orderings():
    """Several methyl rotors give too many hydrogen orderings to try; the best one is still found."""
    from qumol import puzzles

    C = np.array([[0, 0, 0], [1.53, 0, 0], [-0.51, 1.44, 0], [-0.51, -0.72, 1.25], [-0.51, -0.72, -1.25]])
    symbols, coords, bonds = ["C"] * 5, list(C), [(0, i, 1) for i in range(1, 5)]
    for i in range(1, 5):  # neopentane: 4 methyls, (3!)^4 = 1296 orderings
        d = C[i] / np.linalg.norm(C[i])
        a = np.cross(d, [0.3, 1, 0.2]); a /= np.linalg.norm(a)
        b = np.cross(d, a)
        for k in range(3):
            t = 2 * np.pi * k / 3
            bonds.append((i, len(symbols), 1)); symbols.append("H")
            coords.append(C[i] + 1.09 * (0.334 * d + 0.943 * (np.cos(t) * a + np.sin(t) * b)))
    p = {"symbols": symbols, "coords": np.array(coords), "bonds": bonds}
    perm = np.random.default_rng(5).permutation(len(symbols))
    inv = np.argsort(perm)
    res = puzzles.compare(p, [symbols[i] for i in perm], p["coords"][perm] + 1.0,
                          [(int(inv[a]), int(inv[b]), o) for a, b, o in bonds])
    assert res["rmsd"] < 1e-6


def _shuffled(p, seed):
    perm = np.random.default_rng(seed).permutation(len(p["symbols"]))
    inv = np.argsort(perm)
    return ([p["symbols"][i] for i in perm], np.asarray(p["coords"])[perm] + 1.0,
            [(int(inv[a]), int(inv[b]), o) for a, b, o in p["bonds"]])


def test_rmsd_without_heavy_atoms():
    from qumol import puzzles

    p = {"symbols": ["H", "H"], "coords": np.array([[0, 0, 0], [0.741, 0, 0]]), "bonds": [(0, 1, 1)]}
    symbols, x, bonds = _shuffled(p, 1)
    assert puzzles.compare(p, symbols, x, bonds)["rmsd"] < 1e-6


def test_bridging_hydrogens_map_one_to_one():
    """Diborane: each bridging H is bonded to both borons, but maps to a single player atom."""
    from qumol import puzzles

    coords = [[0.885, 0, 0], [-0.885, 0, 0], [0, 0.97, 0], [0, -0.97, 0],
              [1.45, 0, 1.04], [1.45, 0, -1.04], [-1.45, 0, 1.04], [-1.45, 0, -1.04]]
    bonds = [(0, 2, 1), (0, 3, 1), (1, 2, 1), (1, 3, 1), (0, 4, 1), (0, 5, 1), (1, 6, 1), (1, 7, 1)]
    p = {"symbols": ["B", "B"] + ["H"] * 6, "coords": np.array(coords, dtype=float), "bonds": bonds}
    symbols, x, pbonds = _shuffled(p, 2)
    res = puzzles.compare(p, symbols, x, pbonds)
    assert res["rmsd"] < 1e-6
    assert all(g is not None for g in res["ghost"])  # every player atom got exactly one reference atom
    for idx in puzzles._mappings(p, symbols, pbonds, x):
        assert sorted(idx) == list(range(len(symbols)))  # no candidate maps two atoms onto one


def test_mapping_search_is_bounded(monkeypatch):
    """The total number of alignments tried per solve is capped, whatever the symmetry."""
    from qumol import puzzles

    p = puzzles.load()["se100-benzene"]
    symbols, x, bonds = _shuffled(p, 4)
    assert sum(1 for _ in puzzles._mappings(p, symbols, bonds, x)) == 12  # D6h: 12 heavy-atom matches
    monkeypatch.setattr(puzzles, "MAX_FITS", 5)
    assert sum(1 for _ in puzzles._mappings(p, symbols, bonds, x)) == 5
