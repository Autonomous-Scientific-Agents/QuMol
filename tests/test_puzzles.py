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

    atoms, bonds = _water(scale=1.05, shift=4.0)
    ok = client.post("/api/puzzles/solve", headers=h, json={"attempt_id": aid, "atoms": atoms, "bonds": bonds}).json()
    assert ok["correct"] and 0.02 < ok["rmsd"] < 0.06 and ok["tries"] == 2
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


def test_puzzle_leaderboard_ranks_by_solved_then_time(client):
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
