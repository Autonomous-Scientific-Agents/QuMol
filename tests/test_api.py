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
    assert "Hand-built" in labels and "New to QuMol" in labels and "First claim: C2H6O" in labels
    assert j["score"] == j["total"] > 0
    assert j["optimized_geometry_id"].startswith("C2H6Oq0m1-")
    assert len(j["frames"]) > 1 and len(j["coords_opt"]) == 9

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
    labels = [l[0] for l in j["lines"]]
    assert "Geometry skill" not in labels and "Hand-built" not in labels
    h2, _ = player(client, "xyzfan")
    j = client.post("/api/submissions", json={**ethanol(), "input_method": "xyz"}, headers=h2).json()
    labels = [l[0] for l in j["lines"]]
    assert "Geometry skill" in labels and "Hand-built" not in labels
    assert "New to QuMol" not in labels  # someone else found it first
    assert client.post("/api/submissions", json={**ethanol(), "input_method": "magic"}, headers=h).status_code == 400


def test_rejects_bad_structures(client):
    h, _ = player(client)
    apart = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "C", "x": 5, "y": 0, "z": 0}], "bonds": []}
    assert client.post("/api/submissions", json=apart, headers=h).status_code == 400
    over = {"atoms": [{"el": "O", "x": 0, "y": 0, "z": 0}] + [{"el": "H", "x": i, "y": 1, "z": 0} for i in range(3)],
            "bonds": [[0, 1, 1], [0, 2, 1], [0, 3, 1]]}
    assert "too many bonds" in client.post("/api/submissions", json=over, headers=h).json()["detail"]
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
