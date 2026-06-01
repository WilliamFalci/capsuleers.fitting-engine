#!/usr/bin/env python3
"""
Headless pyfa-org/Pyfa stat oracle for the differential parity harness.

Reads a JSON array of fit-specs from stdin, computes each with pyfa's `eos`
engine (All-V character), and writes a JSON array of normalized stat blocks to
stdout — one schema shared with the JS side (test/diff/stat-schema.mjs).

Run via the oracle venv with the wx stub on PYTHONPATH (see scripts/
setup-pyfa-oracle.sh and test/diff/run-diff.mjs, which spawns this with the
right cwd/env). All eve.db loading happens once; the input is batched.

Fit-spec shape:
  { "id": "...", "shipTypeID": 587,
    "modules":   [ {"typeID":..,"state":"ACTIVE","chargeTypeID":..?} ],
    "drones":    [ {"typeID":..,"count":N,"active":N} ],
    "subsystems":[ {"typeID":..} ],
    "modeTypeID": ..? }
"""
import sys
sys._called_from_test = True  # eos -> in-memory saveddata + auto-created schema

import json

import eos.db
from eos.saveddata.fit import Fit
from eos.saveddata.ship import Ship
from eos.saveddata.module import Module
from eos.saveddata.drone import Drone
from eos.saveddata.character import Character
from eos.const import FittingModuleState
try:
    from eos.saveddata.damagePattern import DamagePattern
except Exception:
    DamagePattern = None

_STATE = {"OFFLINE": -1, "ONLINE": 0, "ACTIVE": 1, "OVERHEATED": 2}
_CHAR = None
_UNIFORM = DamagePattern(25, 25, 25, 25) if DamagePattern else None


def _item(tid):
    return eos.db.getItem(int(tid))


def build_fit(spec):
    fit = Fit()
    fit.ship = Ship(_item(spec["shipTypeID"]))
    fit.character = _CHAR
    if _UNIFORM is not None:
        fit.damagePattern = _UNIFORM

    # Subsystems first so the hull's slot layout is correct before modules.
    for s in spec.get("subsystems", []):
        try:
            sm = Module(_item(s["typeID"]))
            fit.modules.append(sm)
            sm.owner = fit
        except Exception:
            pass

    if spec.get("modeTypeID"):
        try:
            fit.mode = fit.ship.checkModeItem(_item(spec["modeTypeID"]))
        except Exception:
            pass

    for mod in spec.get("modules", []):
        try:
            m = Module(_item(mod["typeID"]))
        except Exception:
            continue
        fit.modules.append(m)
        try:
            m.owner = fit  # wire backref the calc reads (no DB session needed)
        except Exception:
            pass
        try:
            st = _STATE.get(mod.get("state", "ACTIVE"), 1)
            # clamp to what the module supports, then set
            if hasattr(m, "getMaxState"):
                st = min(st, int(m.getMaxState()))
            m.state = FittingModuleState(st)
        except Exception:
            pass
        if mod.get("chargeTypeID"):
            try:
                m.charge = _item(mod["chargeTypeID"])
            except Exception:
                pass

    for d in spec.get("drones", []):
        try:
            dr = Drone(_item(d["typeID"]))
            dr.amount = int(d.get("count", 0))
            dr.amountActive = int(d.get("active", d.get("count", 0)))
            fit.drones.append(dr)
            dr.owner = fit
        except Exception:
            pass

    return fit


def _num(v):
    try:
        return float(v)
    except Exception:
        return None


def stats(fit):
    fit.calculateModifiedAttributes()
    S = fit.ship.getModifiedItemAttr

    def resist(layer):
        # shield -> shield<Dmg>DamageResonance, armor -> armor<Dmg>DamageResonance,
        # hull/structure -> the BARE <dmg>DamageResonance attrs (that's where the
        # Damage Control etc. structure resists live; hullEm... is unused/1.0).
        def g(dmg):
            attr = (dmg[0].lower() + dmg[1:] + "DamageResonance") if layer == "hull" else (layer + dmg + "DamageResonance")
            r = S(attr)
            return None if r is None else (1.0 - r) * 100.0
        return {"em": g("Em"), "thermal": g("Thermal"), "kinetic": g("Kinetic"), "explosive": g("Explosive")}

    hp = fit.hp or {}
    ehp = fit.ehp or {}
    wdps = fit.getWeaponDps(); ddps = fit.getDroneDps(); tdps = fit.getTotalDps()
    wvol = fit.getWeaponVolley()

    return {
        "fitting": {
            "cpuUsed": _num(fit.cpuUsed), "cpuMax": _num(S("cpuOutput")),
            "powerUsed": _num(fit.pgUsed), "powerMax": _num(S("powerOutput")),
            "calibrationUsed": _num(fit.calibrationUsed), "calibrationMax": _num(S("upgradeCapacity")),
        },
        "defense": {
            "shieldHp": _num(hp.get("shield")), "armorHp": _num(hp.get("armor")), "hullHp": _num(hp.get("hull")),
            "shieldResist": resist("shield"), "armorResist": resist("armor"), "hullResist": resist("hull"),
            "ehpShield": _num(ehp.get("shield")), "ehpArmor": _num(ehp.get("armor")), "ehpHull": _num(ehp.get("hull")),
            "ehpTotal": _num((ehp.get("shield") or 0) + (ehp.get("armor") or 0) + (ehp.get("hull") or 0)),
        },
        "offense": {
            "weaponDps": _num(getattr(wdps, "total", 0)), "droneDps": _num(getattr(ddps, "total", 0)),
            "totalDps": _num(getattr(tdps, "total", 0)), "alphaStrike": _num(getattr(wvol, "total", 0)),
        },
        "capacitor": {
            "capacity": _num(S("capacitorCapacity")),
            "stable": bool(fit.capStable),
            "stablePercent": _num(fit.capState) if fit.capStable else None,
            "secondsToEmpty": None if fit.capStable else _num(fit.capState),
        },
        "navigation": {
            "maxVelocity": _num(S("maxVelocity")), "alignTime": _num(fit.alignTime),
            "warpSpeed": _num(fit.warpSpeed), "mass": _num(S("mass")), "agility": _num(S("agility")),
            "signatureRadius": _num(S("signatureRadius")),
        },
        "targeting": {
            "maxTargetingRange": _num(S("maxTargetRange") and S("maxTargetRange") / 1000.0) if S("maxTargetRange") else None,
            "scanResolution": _num(S("scanResolution")),
            "sensorStrength": _num(fit.scanStrength),
            "maxLockedTargets": _num(fit.maxTargets),
            "droneControlRange": _num(S("droneControlDistance") and S("droneControlDistance") / 1000.0) if S("droneControlDistance") else None,
        },
    }


def main():
    global _CHAR
    _CHAR = Character.getAll5()
    specs = json.load(sys.stdin)
    out = []
    for spec in specs:
        rec = {"id": spec.get("id")}
        try:
            rec["stats"] = stats(build_fit(spec))
            rec["ok"] = True
        except Exception as e:
            rec["ok"] = False
            rec["error"] = repr(e)
        out.append(rec)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
