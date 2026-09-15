"""Render the self-contained explainer from sanitized, measured run records."""
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
order = json.loads((HERE / "order.json").read_text())
runs = {key: json.loads((HERE / "runs" / f"{key}.json").read_text()) for key in order}
page = (HERE / "template.html").read_text()
for marker, value in {
    "__RUNS__": json.dumps(runs, separators=(",", ":")).replace("</", "<\\/"),
    "__VERDICT__": (HERE / "verdict.html").read_text(),
    "__INSTALL_FINDINGS__": (HERE / "install-findings.html").read_text(),
}.items():
    page = page.replace(marker, value)
assert not re.search(r"__[A-Z_]+__", page), "Unfilled template marker"
output = HERE.with_suffix(".html")
output.write_text(page)
subprocess.run(["pnpm", "exec", "oxfmt", str(output)], cwd=HERE.parents[1], check=True)
print(f"Rendered {len(runs)} measured runs to {output}")
