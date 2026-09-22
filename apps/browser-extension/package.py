"""Package only the extension's four runtime files; never local state or credentials."""
import json
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
version = json.loads((root / "manifest.json").read_text())["version"]
archive = output / f"iterate-chrome-extension-{version}.zip"
with ZipFile(archive, "w", ZIP_DEFLATED) as bundle:
    for name in ("manifest.json", "index.html", "panel.js", "capnweb.js"):
        bundle.write(root / name, name)
print(archive)
