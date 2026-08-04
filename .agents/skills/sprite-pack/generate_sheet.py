#!/usr/bin/env python3
"""Generate one sprite contact sheet via the OpenAI images API (gpt-image-1).

Stdlib only, matching the sprite pipeline's no-dependency ethos. Reads
OPENAI_API_KEY from the environment — run it under
`doppler run --config dev --` from apps/os. Equivalent curl:

    curl -sS https://api.openai.com/v1/images/generations \
      -H "Authorization: Bearer $OPENAI_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$(python3 -c 'import json,sys;print(json.dumps({"model":"gpt-image-1","prompt":open(sys.argv[1]).read(),"size":"1536x1024","n":1}))' prompt.txt)" \
      | python3 -c 'import json,sys,base64;open(sys.argv[1],"wb").write(base64.b64decode(json.load(sys.stdin)["data"][0]["b64_json"]))' out.png
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--prompt-file", required=True, help="text file holding the image prompt")
    parser.add_argument("--out", required=True, help="destination PNG path")
    parser.add_argument("--size", default="1536x1024", help="1024x1024, 1536x1024, or 1024x1536")
    args = parser.parse_args()

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print("error: OPENAI_API_KEY not set (run under `doppler run --config dev --` from apps/os)", file=sys.stderr)
        return 2

    with open(args.prompt_file, "r", encoding="utf-8") as handle:
        prompt = handle.read().strip()

    request = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=json.dumps(
            {"model": "gpt-image-1", "prompt": prompt, "size": args.size, "n": 1}
        ).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        print(f"error: OpenAI API {error.code}: {error.read().decode('utf-8', 'replace')}", file=sys.stderr)
        return 1

    png = base64.b64decode(payload["data"][0]["b64_json"])
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as handle:
        handle.write(png)
    print(f"wrote {len(png)} bytes to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
