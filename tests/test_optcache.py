"""Reusing earlier optimizations, and the live (streamed) submission endpoint."""

import json

import numpy as np
from conftest import ethanol, player


def _rotated_and_shuffled(sub, seed=1):
    """The same submission turned, moved and with its atoms listed in another order."""
    rng = np.random.default_rng(seed)
    q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    if np.linalg.det(q) < 0:
        q[:, 0] *= -1
    xyz = np.array([[a["x"], a["y"], a["z"]] for a in sub["atoms"]]) @ q.T + [3.0, -2.0, 1.0]
    order = rng.permutation(len(sub["atoms"]))  # new atom k is old atom order[k]
    new_of_old = {int(o): k for k, o in enumerate(order)}
    atoms = [{"el": sub["atoms"][o]["el"], "x": xyz[o][0], "y": xyz[o][1], "z": xyz[o][2]} for o in order]
    bonds = [[new_of_old[a], new_of_old[b], o] for a, b, o in sub["bonds"]]
    return {"atoms": atoms, "bonds": bonds}


def _count_optimizations(monkeypatch):
    from qumol import scoring

    calc, calls = scoring.get_calculator(), []
    real = calc.optimize

    def counting(*a, **k):
        calls.append(1)
        return real(*a, **k)

    monkeypatch.setattr(calc, "optimize", counting)
    return calls


def test_same_start_reuses_the_optimization(client, monkeypatch):
    calls = _count_optimizations(monkeypatch)
    first = client.post("/api/submissions", json=ethanol(), headers=player(client)[0]).json()
    assert len(calls) == 1 and not first["reused"]

    # Another player, same start but turned, moved and renumbered: served from the cache.
    moved = _rotated_and_shuffled(ethanol())
    j = client.post("/api/submissions", json=moved, headers=player(client, "eve")[0]).json()
    assert len(calls) == 1 and j["reused"] and j["log"]["reused"]
    assert j["energies"] == first["energies"]
    assert j["optimized_geometry_id"] == first["optimized_geometry_id"]  # same structure
    assert "reused an earlier calculation" in j["log"]["events"][0]
    # The trajectory is in the new player's atom order and frame: frame 0 sits on their input
    # (hydrogens tidied), and every bond survives in the final structure.
    start = np.array([[a["x"], a["y"], a["z"]] for a in moved["atoms"]])
    assert np.abs(np.array(j["frames"][0]) - start).max() < 0.5
    opt = np.array(j["coords_opt"])
    assert all(np.linalg.norm(opt[a] - opt[b]) < 1.6 for a, b, _ in moved["bonds"])
    assert j["stable"] and j["score"] > 0  # scored like a fresh run (Geometry, Stable, ...)

    # Moving one atom by 0.4 Å makes it a new start (the key is a 0.1 Å grid): optimized again.
    far = ethanol()
    far["atoms"][2]["x"] += 0.4
    client.post("/api/submissions", json=far, headers=player(client, "bob")[0])
    assert len(calls) == 2


def test_different_bonding_is_not_reused(client, monkeypatch):
    calls = _count_optimizations(monkeypatch)
    h, _ = player(client)
    triple = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "O", "x": 1.13, "y": 0, "z": 0}], "bonds": [[0, 1, 3]]}
    double = {**triple, "bonds": [[0, 1, 2]]}  # same coordinates, a carbene radical instead
    assert not client.post("/api/submissions", json=triple, headers=h).json()["reused"]
    assert not client.post("/api/submissions", json=double, headers=h).json()["reused"]
    assert len(calls) == 2


def _events(r):
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in r.text.splitlines() if line]


def test_streamed_submission(client):
    h, _ = player(client)
    ev = _events(client.post("/api/submissions/stream", json=ethanol(), headers=h))
    kinds = [e["type"] for e in ev]
    assert kinds[0] == "start" and kinds[-1] == "result" and "frame" in kinds
    assert ev[0]["n_atoms"] == 9 and ev[0]["reused"] is False
    frame = next(e for e in ev if e["type"] == "frame")
    assert len(frame["coords"]) == 9 and frame["points"][0][0] == "input"
    res = ev[-1]["result"]
    assert res["smiles"] == "CCO" and res["score"] == res["total"] > 0 and not res["reused"]

    # The same start again, streamed: replayed from the cache through the same events.
    ev = _events(client.post("/api/submissions/stream", json=ethanol(shift=2.0), headers=h))
    assert ev[0]["reused"] and ev[-1]["result"]["reused"] and any(e["type"] == "frame" for e in ev)
    assert ev[-1]["result"]["already"]


def test_streamed_errors(client):
    h, _ = player(client)
    pieces = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "C", "x": 3, "y": 0, "z": 0}], "bonds": []}
    ev = _events(client.post("/api/submissions/stream", json=pieces, headers=h))
    assert ev[-1]["type"] == "error" and ev[-1]["status"] == 400 and "pieces" in ev[-1]["detail"]
    # authentication and validation still fail as plain HTTP errors, before any streaming
    assert client.post("/api/submissions/stream", json=ethanol()).status_code == 401
    assert client.post("/api/submissions/stream", json={"atoms": []}, headers=h).status_code == 422


def test_swapped_bond_orders_are_not_reused(client, monkeypatch):
    """O=O-O and O-O=O on the same coordinates hash alike and share a SMILES, but the stored
    atoms must not be mapped onto the new ones with the double bond on the wrong side."""
    calls = _count_optimizations(monkeypatch)
    h, _ = player(client)
    atoms = [{"el": "O", "x": -1.05, "y": 0.1, "z": 0.0}, {"el": "O", "x": 0.0, "y": 0.6, "z": 0.0},
             {"el": "O", "x": 1.45, "y": -0.1, "z": 0.0}]  # lopsided: reversed, it fits 0.23 Å off
    first = client.post("/api/submissions", json={"atoms": atoms, "bonds": [[0, 1, 2], [1, 2, 1]]}, headers=h).json()
    j = client.post("/api/submissions", json={"atoms": atoms, "bonds": [[0, 1, 1], [1, 2, 2]]}, headers=h).json()
    assert first["smiles"] == j["smiles"]
    assert not j["reused"] and len(calls) == 2
