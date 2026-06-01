#!/usr/bin/env bash
# Set up the pyfa-org/Pyfa headless oracle used by the differential parity
# harness (test/diff). Clones pyfa, creates a venv with the minimal eos deps,
# stubs wx (config.py imports only wx.Colour; eos compute is wx-free), and
# builds the gamedata eve.db. Idempotent — safe to re-run.
#
#   bash scripts/setup-pyfa-oracle.sh            # set up / verify
#   bash scripts/setup-pyfa-oracle.sh --rebuild  # force-rebuild eve.db
#
# Everything lands under .pyfa/ (gitignored, ~100 MB). Not part of the package.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYFA="$ROOT/.pyfa"
VENV="$PYFA/.venv"
STUBS="$PYFA/_oracle_stubs"
PY="${PYTHON:-python3}"

echo "[oracle] root: $PYFA"

# 1. clone pyfa-org/Pyfa (shallow)
if [ ! -d "$PYFA/eos" ]; then
  echo "[oracle] cloning pyfa-org/Pyfa..."
  git clone --depth 1 https://github.com/pyfa-org/Pyfa.git "$PYFA"
else
  echo "[oracle] pyfa already cloned"
fi

# 2. venv + minimal eos/db_update deps (no wx, no numpy, no matplotlib)
if [ ! -x "$VENV/bin/python" ]; then
  echo "[oracle] creating venv..."
  "$PY" -m venv "$VENV"
fi
echo "[oracle] installing deps..."
"$VENV/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1 || true
"$VENV/bin/pip" install --quiet "sqlalchemy==1.4.50" logbook python-dateutil pyyaml cryptography

# 3. wx stub — config.py imports wx only for wx.Colour (UI slot colours).
mkdir -p "$STUBS"
cat > "$STUBS/wx.py" <<'PY'
# Headless stub: pyfa's config.py imports wx only for wx.Colour. eos compute
# never touches wx (grep -rl wx eos/ == 0). This satisfies the import.
class Colour:
    def __init__(self, *a, **k): pass
def __getattr__(name):
    return type(name, (), {'__init__': lambda self, *a, **k: None})
PY

# 4. build gamedata eve.db from the repo's staticdata
if [ "${1:-}" = "--rebuild" ]; then rm -f "$PYFA/eve.db"; fi
if [ ! -f "$PYFA/eve.db" ]; then
  echo "[oracle] building eve.db (this takes ~30-60s)..."
  ( cd "$PYFA" && PYTHONPATH="$STUBS" "$VENV/bin/python" db_update.py )
else
  echo "[oracle] eve.db already built ($(du -h "$PYFA/eve.db" | cut -f1))"
fi

# 5. smoke: compute a bare Rifter to confirm the oracle runs
echo "[oracle] smoke test..."
( cd "$PYFA" && PYTHONPATH="$STUBS" "$VENV/bin/python" - <<'PY'
import sys; sys._called_from_test = True
import eos.db
from eos.saveddata.fit import Fit
from eos.saveddata.ship import Ship
from eos.saveddata.character import Character
f = Fit(); f.ship = Ship(eos.db.getItem(587)); f.character = Character.getAll5()
f.calculateModifiedAttributes()
cpu = f.ship.getModifiedItemAttr("cpuOutput")
assert abs(cpu - 162.5) < 1, f"unexpected Rifter cpuOutput {cpu}"
print(f"[oracle] OK — Rifter cpuOutput={cpu}")
PY
)
echo "[oracle] ready."
