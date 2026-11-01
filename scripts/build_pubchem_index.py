"""Build QuMol's local PubChem lookup table from the PubChem "Extras" dump.

Reads CID-InChI-Key.gz and CID-Title.gz (as downloaded by Chemical-Name-Extractor's
scripts/download_datasets.sh) and keeps only compounds QuMol can build:
1-10 heavy atoms, only H C N O S F, a single neutral component, no isotopes.
The result is a small SQLite file mapping InChIKey -> CID -> title.

    python3 scripts/build_pubchem_index.py \\
        --src ~/git/asa/ChemicalNameExtractor/data/pubchem --out pubchem.sqlite
    scp pubchem.sqlite chemgraphserver:~/qumol/data/pubchem.sqlite

Standard library only, so it runs with any python3 >= 3.8. Takes a while: the full
InChI-Key file has well over 100 million lines.
"""

import argparse
import gzip
import os
import re
import sqlite3
import sys
import time

ALLOWED = {"C", "H", "N", "O", "S", "F"}
MAX_HEAVY = 10
FORMULA_RE = re.compile(r"([A-Z][a-z]?)(\d*)")


def heavy_atoms(inchi: str):
    """Heavy-atom count if QuMol could build this compound, else None."""
    parts = inchi.split("/")
    if len(parts) < 2 or not parts[0].startswith("InChI="):
        return None
    formula = parts[1]
    if not formula or "." in formula or formula[0].isdigit():
        return None  # mixtures, salts, multiple components
    for layer in parts[2:]:
        if layer[:1] in ("q", "p", "i"):
            return None  # charged, (de)protonated, or isotopically labeled
    pieces = FORMULA_RE.findall(formula)
    if "".join(e + n for e, n in pieces) != formula:
        return None
    heavy = 0
    for el, n in pieces:
        if el not in ALLOWED:
            return None
        if el != "H":
            heavy += int(n or 1)
    return heavy if 1 <= heavy <= MAX_HEAVY else None


def open_any(path):
    return gzip.open(path, "rt", encoding="utf-8", errors="replace") if path.endswith(".gz") else open(
        path, encoding="utf-8", errors="replace")


def find(src, name):
    for cand in (name + ".gz", name):
        p = os.path.join(src, cand)
        if os.path.exists(p):
            return p
    sys.exit(f"Can't find {name}(.gz) in {src}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="folder with CID-InChI-Key.gz and CID-Title.gz")
    ap.add_argument("--out", default="pubchem.sqlite")
    a = ap.parse_args()
    src = os.path.expanduser(a.src)
    keys_path, titles_path = find(src, "CID-InChI-Key"), find(src, "CID-Title")

    tmp = a.out + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = sqlite3.connect(tmp)
    con.executescript("""
        PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
        CREATE TABLE compounds (cid INTEGER PRIMARY KEY, inchikey TEXT NOT NULL,
                                key14 TEXT NOT NULL, heavy INTEGER NOT NULL, title TEXT);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    """)

    t0 = time.time()
    kept, n, batch = 0, 0, []
    with open_any(keys_path) as f:
        for line in f:
            n += 1
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 3:
                continue
            heavy = heavy_atoms(cols[1])
            if heavy is None:
                continue
            key = cols[2].strip()
            batch.append((int(cols[0]), key, key[:14], heavy))
            if len(batch) >= 100_000:
                con.executemany("INSERT OR IGNORE INTO compounds(cid, inchikey, key14, heavy) VALUES (?,?,?,?)", batch)
                kept += len(batch)
                batch.clear()
            if n % 10_000_000 == 0:
                print(f"  {n / 1e6:.0f}M InChIKeys read, {kept + len(batch):,} kept ({time.time() - t0:.0f}s)", flush=True)
    con.executemany("INSERT OR IGNORE INTO compounds(cid, inchikey, key14, heavy) VALUES (?,?,?,?)", batch)
    kept += len(batch)
    con.commit()
    print(f"InChIKeys: {n:,} read, {kept:,} kept", flush=True)

    t1 = time.time()
    n, titled, batch = 0, 0, []
    with open_any(titles_path) as f:
        for line in f:
            n += 1
            cid, _, title = line.rstrip("\n").partition("\t")
            if not title:
                continue
            batch.append((title[:200], int(cid)))
            if len(batch) >= 200_000:
                titled += con.executemany("UPDATE compounds SET title=? WHERE cid=?", batch).rowcount
                batch.clear()
            if n % 10_000_000 == 0:
                print(f"  {n / 1e6:.0f}M titles read ({time.time() - t1:.0f}s)", flush=True)
    titled += con.executemany("UPDATE compounds SET title=? WHERE cid=?", batch).rowcount
    con.commit()
    print(f"Titles: {n:,} read, {titled:,} matched", flush=True)

    con.executescript("""
        CREATE INDEX compounds_key ON compounds(inchikey);
        CREATE INDEX compounds_key14 ON compounds(key14);
    """)
    con.execute("INSERT INTO meta VALUES ('built', ?)", (time.strftime("%Y-%m-%d"),))
    con.execute("INSERT INTO meta VALUES ('source_mtime', ?)",
                (time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(keys_path))),))
    con.commit()
    con.execute("VACUUM")
    con.close()
    os.replace(tmp, a.out)
    print(f"Wrote {a.out} ({os.path.getsize(a.out) / 1e6:.1f} MB) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
