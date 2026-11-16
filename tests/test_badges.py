import pytest

from conftest import ethanol, player
from qumol import badges


def test_catalog_is_valid_and_mistakes_are_named():
    cat = badges.catalog()
    assert {lad["stat"] for lad in cat["ladder"]} == badges.STATS
    with pytest.raises(ValueError, match="ladder x"):
        badges.check({"ladder": [{"key": "x", "name": "X", "stat": "nope", "tiers": []}]})
    with pytest.raises(ValueError, match="badge y"):
        badges.check({"badge": [{"key": "y", "icon": "🙂", "title": "Y", "rule": "bond:5"}]})
    with pytest.raises(ValueError, match="increasing"):
        badges.check({"ladder": [{"key": "z", "name": "Z", "stat": "points",
                                  "tiers": [{"at": 5, "icon": "a", "title": "A"}, {"at": 1, "icon": "b", "title": "B"}]}]})


def test_badges_follow_play(client):
    h, _ = player(client)
    assert client.get("/api/badges").status_code == 401
    b = client.get("/api/badges", headers=h).json()
    assert b["earned"] == [] and {lad["key"] for lad in b["ladders"]} == {"builder", "puzzler", "chef", "stars"}

    client.post("/api/submissions", json=ethanol(), headers=h)
    b = client.get("/api/badges", headers=h).json()
    assert {"builder-1", "ethanol"} <= set(b["earned"]) and "ring" not in b["earned"]
    assert next(lad for lad in b["ladders"] if lad["key"] == "builder")["value"] == 1

    # Cooking the same molecule is a chef tier, but not a happy accident (already built by hand).
    client.post("/api/submissions", json={**ethanol(0.3), "input_method": "cook"}, headers=h)
    b = client.get("/api/badges", headers=h).json()
    assert "chef-1" in b["earned"] and "accident" not in b["earned"]

    assert client.post("/api/badges/event", json={"event": "hack"}, headers=h).status_code == 422
    r = client.post("/api/badges/event", json={"event": "lesson"}, headers=h)
    assert "lesson" in r.json()["earned"]
    client.post("/api/badges/event", json={"event": "lesson"}, headers=h)  # reporting twice is harmless


def test_titles_and_icons_come_from_the_file(client, tmp_path, monkeypatch):
    f = tmp_path / "badges.toml"
    f.write_text(badges.PATH.read_text(encoding="utf-8").replace('title = "Happy Hour"', 'title = "Cheers"'), encoding="utf-8")
    monkeypatch.setattr(badges, "PATH", f)
    h, _ = player(client)
    client.post("/api/submissions", json=ethanol(), headers=h)
    eth = next(x for x in client.get("/api/badges", headers=h).json()["badges"] if x["key"] == "ethanol")
    assert eth["title"] == "Cheers" and eth["earned"]
