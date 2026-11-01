import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("QUMOL_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("QUMOL_PUBCHEM", "0")
    from fastapi.testclient import TestClient

    from qumol.app import app

    with TestClient(app) as c:
        yield c


def ethanol(shift: float = 0.0):
    """Ethanol with a slightly sloppy hand-built geometry."""
    heavy = [("C", 0.0, 0.0, 0.0), ("C", 1.6, 0.1, 0.0), ("O", 2.1, 1.3, 0.2)]
    atoms = [{"el": e, "x": x + shift, "y": y, "z": z} for e, x, y, z in heavy]
    bonds = [[0, 1, 1], [1, 2, 1]]
    hs = [(0, (-0.5, 0.9, 0.3)), (0, (-0.4, -0.6, 0.8)), (0, (-0.3, -0.4, -0.9)),
          (1, (0.3, -0.5, 0.8)), (1, (0.2, -0.4, -0.9)), (2, (0.9, 0.0, 0.2))]
    for i, (dx, dy, dz) in hs:
        _, x, y, z = heavy[i]
        atoms.append({"el": "H", "x": x + dx + shift, "y": y + dy, "z": z + dz})
        bonds.append([i, len(atoms) - 1, 1])
    return {"atoms": atoms, "bonds": bonds}


def player(client, nick="murat"):
    r = client.post("/api/players", json={"nickname": nick})
    assert r.status_code == 200, r.text
    j = r.json()
    return {"Authorization": "Bearer " + j["token"]}, j
