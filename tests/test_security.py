from conftest import ethanol, player


def test_security_headers_and_no_docs(client):
    r = client.get("/")
    assert r.status_code == 200 and "<title>QuMol</title>" in r.text
    csp = r.headers["content-security-policy"]
    assert "script-src 'self' 'wasm-unsafe-eval'" in csp and "frame-ancestors 'none'" in csp
    assert "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert client.get("/api/health").headers["x-frame-options"] == "DENY"
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/app.js").status_code == 200


def test_no_inline_scripts_or_third_party_code():
    html = open("web/index.html").read()
    js = open("web/app.js").read()
    assert "<script>" not in html and "<script type=\"module\">" not in html and "importmap" not in html
    for host in ("unpkg.com", "jsdelivr", "cdnjs"):
        assert host not in html and host not in js


def test_body_size_limit(client):
    h, _ = player(client)
    big = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}], "bonds": [], "pad": "x" * 400_000}
    assert client.post("/api/submissions", json=big, headers=h).status_code == 413


def test_input_bounds(client):
    h, _ = player(client)
    bad = [
        {"atoms": [{"el": "C" * 1000, "x": 0, "y": 0, "z": 0}]},
        {"atoms": [{"el": "C", "x": 1e9, "y": 0, "z": 0}]},
        {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}], "bonds": [[0, 99999, 1]]},
        {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}], "mode": "anything"},
        {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}] * 151},
    ]
    for b in bad:
        assert client.post("/api/submissions", json=b, headers=h).status_code == 422, b
    nan = '{"atoms":[{"el":"C","x":NaN,"y":0,"z":0}]}'
    r = client.post("/api/submissions", content=nan, headers={**h, "Content-Type": "application/json"})
    assert r.status_code == 422
    assert client.get("/api/submissions/mine?limit=-1", headers=h).status_code == 422
    assert client.post("/api/players", json={"nickname": "<script>alert(1)</script>"}).status_code == 400
    assert client.get("/api/me", headers={"Authorization": "Bearer " + "a" * 500}).status_code == 401


def test_rate_limits(client):
    for i in range(20):
        assert client.post("/api/players", json={"nickname": f"user{i}"}).status_code == 200
    r = client.post("/api/players", json={"nickname": "user20"})
    assert r.status_code == 429 and "Retry-After" in r.headers

    from qumol.security import limiter
    limiter.reset()
    h, j = player(client, "target")
    for _ in range(5):
        client.post("/api/players/recover", json={"nickname": "target", "recovery_code": "AAAA-AAAA-AAAA-AAAA"})
    # even the right code is refused once the per-nickname limit is hit
    r = client.post("/api/players/recover", json={"nickname": "target", "recovery_code": j["recovery_code"]})
    assert r.status_code == 429

    limiter.reset()
    codes = [client.post("/api/submissions", json=ethanol(), headers=h).status_code for _ in range(21)]
    assert codes[:20] == [200] * 20 and codes[20] == 429


def test_audit_fixes(client):
    import pytest
    from fastapi import HTTPException

    from qumol.security import one_at_a_time

    h, _ = player(client)
    # atoms hundreds of Å apart would cost thousands of optimizer steps: rejected up front
    far = {"atoms": [{"el": "C", "x": 0, "y": 0, "z": 0}, {"el": "C", "x": 400, "y": 0, "z": 0}], "bonds": [[0, 1, 1]]}
    assert "too long" in client.post("/api/submissions", json=far, headers=h).json()["detail"]
    # duplicate bonds on the live-SMILES endpoint: clean 400, not a 500
    dup = {"atoms": [{"el": "C"}, {"el": "C"}], "bonds": [[0, 1, 1], [0, 1, 1]]}
    assert client.post("/api/smiles", json=dup).status_code == 400
    many = {"atoms": [{"el": "C"}] * 31, "bonds": []}
    assert client.post("/api/smiles", json=many).status_code == 400
    # only one in-flight submission per player
    with one_at_a_time("player:x"):
        with pytest.raises(HTTPException) as e:
            with one_at_a_time("player:x"):
                pass
        assert e.value.status_code == 429
    with one_at_a_time("player:x"):
        pass  # released again
    # stats are cached: a new submission doesn't change them until the cache expires
    before = client.get("/api/stats").json()["submissions"]
    client.post("/api/submissions", json=ethanol(), headers=h)
    assert client.get("/api/stats").json()["submissions"] == before


def test_disk_guard(client, monkeypatch):
    import qumol.security as sec

    h, _ = player(client)
    monkeypatch.setattr(sec, "MIN_FREE_BYTES", 1 << 62)
    assert client.post("/api/submissions", json=ethanol(), headers=h).status_code == 503
    assert client.post("/api/players", json={"nickname": "late"}).status_code == 503


def test_game_files_are_revalidated(client):
    """A deploy must reach players: index.html and app.js may not be served from a stale cache."""
    for path in ("/", "/app.js"):
        r = client.get(path)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-cache", path


def test_rate_limiter_memory_is_capped(monkeypatch):
    from qumol.security import RateLimiter

    lim = RateLimiter()
    monkeypatch.setattr(RateLimiter, "MAX_KEYS", 100)
    lim.hit("kept", 5, 86400)
    for i in range(500):  # sprayed keys with a daily window: none expire
        lim.hit(f"spray:{i}", 5, 86400)
        if i % 50 == 0:
            lim.hit("kept", 50, 86400)  # recently used keys survive
    assert len(lim._hits) == 100 and "kept" in lim._hits
