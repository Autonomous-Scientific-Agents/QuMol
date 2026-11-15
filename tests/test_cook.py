import json

import numpy as np
import pytest

from conftest import ethanol, player

pytest.importorskip("ase")

from qumol import cook  # noqa: E402
from qumol.chem import smiles_of, validate  # noqa: E402


def test_fragments_and_summary():
    syms = ["C", "O", "C", "O", "N"]
    x = [[0, 0, 0], [1.13, 0, 0], [5, 0, 0], [6.13, 0, 0], [10, 0, 0]]
    assert cook.fragments(syms, x) == [[0, 1], [2, 3], [4]]
    assert cook.pot_summary(syms, x) == "2×CO + N"


def test_saturate_reads_bond_orders_from_lengths():
    # Acetylene skeleton (C≡C 1.20 Å) gets one H per carbon; ethane-like (1.54 Å) gets three.
    syms, x, bonds = cook.saturate(["C", "C"], [[0, 0, 0], [1.20, 0, 0]])
    assert syms.count("H") == 2 and (0, 1, 3) in bonds
    assert smiles_of(validate(syms, x, bonds)) == "C#C"
    syms, x, bonds = cook.saturate(["C", "C"], [[0, 0, 0], [1.54, 0, 0]])
    assert smiles_of(validate(syms, x, bonds)) == "CC"
    syms, x, bonds = cook.saturate(["C"], [[0, 0, 0]])  # a lone atom
    assert syms == ["C", "H", "H", "H", "H"]
    # Hydrogens are placed at bonding distance and not on top of each other.
    h = x[1:]
    assert all(1.0 < np.linalg.norm(p) < 1.2 for p in h)
    assert min(np.linalg.norm(h[i] - h[j]) for i in range(4) for j in range(i + 1, 4)) > 1.2


def test_products_dedupe_and_skip_single_atoms():
    syms = ["C", "O", "C", "O", "N"]
    x = [[0, 0, 0], [1.13, 0, 0], [5, 0, 0], [6.13, 0, 0], [10, 0, 0]]
    p = cook.products(syms, x)
    assert len(p) == 1 and p[0]["heavy"] == 2  # two identical CO pieces, N left out
    assert [c["idx"] for c in p[0]["copies"]] == [[0, 1], [2, 3]]
    c = p[0]["copies"][1]  # pot coordinates: the C of the second CO is still at x = 5
    assert c["atoms"][0]["x"] == 5 and len(c["atoms"]) == 4 and c["atoms"][2]["el"] == "H"
    assert p[0]["bonds"] and all(a["el"] in "CHO" for a in p[0]["atoms"])


def test_check_recipe():
    assert cook.check_recipe({"C": 2, "O": 1}) == ["C", "C", "O"]
    assert cook.check_recipe({"C": 1, "H": 2}) == ["C", "H", "H"]
    for bad in ({"C": 1}, {"C": 11}, {"S": 2}, {"C": 6, "O": 5}, {"H": 4}, {"C": 2, "H": 11}):
        with pytest.raises(ValueError):
            cook.check_recipe(bad)


def test_cook_runs_and_streams(monkeypatch):
    monkeypatch.setenv("QUMOL_COOK_METHOD", "emt")
    events = []
    r = cook.cook({"C": 3, "O": 1}, 1500, seed=1, on_event=events.append)
    assert events[0]["type"] == "start" and len(events[0]["coords"]) == 4
    frames = [e for e in events if e["type"] == "frame"]
    assert len(frames) > 50 and frames[-1]["quench"]
    assert r["symbols"] == ["C", "C", "C", "O"] and r["products"]
    json.dumps(r)  # plain JSON


def test_cook_api_and_cook_submission(client, monkeypatch):
    monkeypatch.setenv("QUMOL_COOK_METHOD", "emt")
    h, _ = player(client)
    assert client.post("/api/cook/stream", json={"recipe": {"C": 3}}).status_code == 401
    assert client.post("/api/cook/stream", json={"recipe": {"C": 1}}, headers=h).status_code == 400
    assert client.post("/api/cook/stream", json={"recipe": {"S": 2}}, headers=h).status_code == 422
    assert client.post("/api/cook/stream", json={"recipe": {"C": 3}, "temp": 9000}, headers=h).status_code == 422
    r = client.post("/api/cook/stream", json={"recipe": {"C": 3, "O": 1}, "temp": 1200}, headers=h)
    assert r.status_code == 200
    events = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    assert events[0]["type"] == "start" and events[-1]["type"] == "result"
    assert any(e["type"] == "frame" for e in events)
    assert client.get("/api/health").json()["cook"] is True

    # A cooked molecule is scored like any other, without hand-built or geometry points.
    j = client.post("/api/submissions", json={**ethanol(), "input_method": "cook"}, headers=h).json()
    labels = [l[0] for l in j["lines"]]
    assert "Hand-built" not in labels
    assert next(l for l in j["lines"] if l[0] == "Geometry")[1:] == [0, "cooked in the beaker"]
    board = client.get("/api/leaderboard/cook").json()
    assert board["rows"][0]["nickname"] == "murat" and board["rows"][0]["value"] == j["score"]


def test_cook_from_player_placement(client, monkeypatch):
    monkeypatch.setenv("QUMOL_COOK_METHOD", "emt")
    start = [("C", 0, 0, 0), ("C", 2, 0, 0), ("O", 0, 2, 0)]
    with pytest.raises(ValueError):
        cook.check_start([("C", 0, 0, 0), ("C", 0.3, 0, 0)])  # on top of each other
    with pytest.raises(ValueError):
        cook.check_start([("C", 0, 0, 0), ("C", 9, 0, 0)])  # outside the beaker
    events = []
    r = cook.cook(None, 900, seed=2, on_event=events.append, start=start)
    assert r["symbols"] == ["C", "C", "O"] and events[0]["coords"][1] == [2, 0, 0]

    h, _ = player(client)
    body = {"atoms": [{"el": e, "x": x, "y": y, "z": z} for e, x, y, z in start], "temp": 900}
    r = client.post("/api/cook/stream", json=body, headers=h)
    events = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    assert events[0]["coords"][2] == [0, 2, 0] and events[-1]["type"] == "result"
    bad = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "C", "x": 20, "y": 0, "z": 0}]}
    assert client.post("/api/cook/stream", json=bad, headers=h).status_code == 400


def test_cook_with_hydrogen_and_duration(monkeypatch):
    monkeypatch.setenv("QUMOL_COOK_METHOD", "emt")
    events = []
    r = cook.cook({"C": 2, "H": 2}, 1000, seed=3, on_event=events.append, duration_fs=15)
    assert events[0]["dt_fs"] == 0.5 and events[0]["steps"] == 30 and r["duration_fs"] == 15
    frames = [e for e in events if e["type"] == "frame"]
    assert frames[-2]["t_fs"] == 15 and frames[-1]["quench"]
    # H already bonded in the pot counts toward valence: C-H pieces get fewer added H.
    p = cook.products(["C", "H", "C"], [[0, 0, 0], [1.09, 0, 0], [-1.54, 0, 0]])
    assert p[0]["smiles"] == "CC" and p[0]["copies"][0]["idx"] == [0, 1, 2]
