"""QuMol backend: players, molecule submissions, calculations and leaderboards."""

__version__ = "0.3.0"


def _git_commit() -> str | None:
    """Short hash of the checked-out commit, read straight from .git (no git binary needed)."""
    import os
    from pathlib import Path

    if os.environ.get("QUMOL_COMMIT"):
        return os.environ["QUMOL_COMMIT"][:12]
    git = Path(__file__).resolve().parent.parent / ".git"
    try:
        head = (git / "HEAD").read_text().strip()
        if not head.startswith("ref: "):
            return head[:7]
        ref = head[5:]
        if (git / ref).exists():
            return (git / ref).read_text().strip()[:7]
        for line in (git / "packed-refs").read_text().splitlines():
            if line.endswith(" " + ref):
                return line.split()[0][:7]
    except OSError:
        pass
    return None


__commit__ = _git_commit()
