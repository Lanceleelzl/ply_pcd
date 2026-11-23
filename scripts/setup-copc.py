"""Install the pinned Windows COPC worker into this checkout, without a system install."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MANAGER = ROOT / ".tools/copc-manager"
PREFIX = ROOT / ".tools/copc"
LOCK = ROOT / "scripts/copc-win64.lock"
ARCHIVE = "https://conda.anaconda.org/conda-forge/win-64/micromamba-2.10.0-0.tar.bz2"
SHA256 = "6283f25f8142606d86e81a43c7103b5d4f1d5c2027e3f9d7326eff23b33930d8"


def setup():
    config = json.loads((ROOT / "config/local.json").read_text(encoding="utf-8"))
    custom = config.get("copc_pdal_path")
    pdal = Path(custom) if custom else PREFIX / "Library/bin/pdal.exe"
    fingerprint = hashlib.sha256(LOCK.read_bytes()).hexdigest()
    stamp = PREFIX / "copc-lock.sha256"
    if not custom and pdal.is_file() and stamp.is_file() and stamp.read_text() == fingerprint:
        return
    if not custom:
        MANAGER.mkdir(parents=True, exist_ok=True)
        manager = MANAGER / "micromamba.exe"
        if not manager.exists():
            with tempfile.TemporaryDirectory(dir=MANAGER) as temp:
                archive = Path(temp, "manager.tar.bz2")
                urllib.request.urlretrieve(ARCHIVE, archive)
                if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
                    raise RuntimeError("micromamba checksum mismatch")
                with tarfile.open(archive) as tar:
                    exe = Path(temp, manager.name)
                    exe.write_bytes(tar.extractfile("Library/bin/micromamba.exe").read())
                    exe.replace(manager)
        command = "install" if (PREFIX / "conda-meta/history").is_file() else "create"
        subprocess.run([str(manager), command, "-y", "--no-rc", "-p", str(PREFIX), "-f", str(LOCK)],
                       env={**os.environ, "MAMBA_ROOT_PREFIX": str(MANAGER)}, check=True)
    drivers = subprocess.check_output([str(pdal), "--drivers"])
    if b"writers.copc" not in drivers:
        raise RuntimeError("PDAL does not include writers.copc")
    if not custom:
        stamp.write_text(fingerprint)


if __name__ == "__main__":
    setup()
