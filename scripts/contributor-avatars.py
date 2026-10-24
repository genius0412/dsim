"""Refresh the Contributors page's GitHub avatars: public/contributors/<login>.webp.

    python scripts/contributor-avatars.py

Reads every `github: '<login>'` in src/contributors.ts, fetches that account's avatar from
GitHub at 96 px, and writes it as WebP. Needs Pillow (`pip install pillow`); nothing in the
app depends on it.

WHY THE AVATARS ARE VENDORED rather than loaded from avatars.githubusercontent.com: a
hotlinked image sends every visitor's IP address to GitHub, which would make GitHub a third
party the privacy policy has to name (src/legalText.ts, "Who else touches your data"), and
changing that text makes every account re-accept the terms. Served from our own origin the
page contacts nobody new. Re-run this when someone is added or changes their avatar.
"""

import io
import pathlib
import re
import sys
import urllib.request

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
ROSTER = ROOT / "src" / "contributors.ts"
OUT = ROOT / "public" / "contributors"
SIZE = 96


def main() -> int:
    logins = sorted(set(re.findall(r"github:\s*'([A-Za-z0-9-]+)'", ROSTER.read_text(encoding="utf-8"))))
    if not logins:
        print(f"no github logins found in {ROSTER}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    for login in logins:
        req = urllib.request.Request(
            f"https://github.com/{login}.png?size={SIZE}", headers={"user-agent": "dsim-contributors"}
        )
        with urllib.request.urlopen(req, timeout=20) as res:
            data = res.read()
        img = Image.open(io.BytesIO(data)).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
        dest = OUT / f"{login.lower()}.webp"
        img.save(dest, "WEBP", quality=82, method=6)
        print(f"{login:>16} -> {dest.relative_to(ROOT)} ({dest.stat().st_size} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
