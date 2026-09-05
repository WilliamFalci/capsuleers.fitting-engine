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
    "fighters":  [ {"typeID":..,"count":N,"active":true} ],
    "implants":  [ {"typeID":..} ],
    "boosters":  [ {"typeID":..,"sideEffects":[effectID,..]} ],
    "subsystems":[ {"typeID":..} ],
    "modeTypeID": ..? }

Implants live on the FIT, never on the character: `Fit.appliedImplants` returns
`character.implants` when `implantLocation == CHARACTER`, and the All-V character
carries none — so a fit's implants would silently vanish. It is set explicitly
rather than relied upon (a fresh in-memory Fit leaves the column unset).

Booster SIDE EFFECTS default to inactive in pyfa (`BoosterSideEffect.active =
False`) and our engine models the same opt-in list, so the spec carries the
effectIDs to switch on and both sides start from "none".
"""
import sys
sys._called_from_test = True  # eos -> in-memory saveddata + auto-created schema

import json

import eos.db
from eos.saveddata.fit import Fit
from eos.saveddata.ship import Ship
from eos.saveddata.module import Module
from eos.saveddata.drone import Drone
from eos.saveddata.fighter import Fighter
from eos.saveddata.implant import Implant
from eos.saveddata.booster import Booster
from eos.saveddata.character import Character
from eos.const import FittingModuleState, ImplantLocation
try:
    from eos.saveddata.damagePattern import DamagePattern
except Exception:
    DamagePattern = None

# Force FULL spool-up for Triglavian entropic disintegrators so pyfa matches
# our engine's default (disintegratorSpoolPercent = 1 = fully spooled). pyfa's
# default is unspooled (0 stacks) → ~3.1x lower disintegrator DPS otherwise.
try:
    from eos.utils.spoolSupport import SpoolOptions
    from eos.const import SpoolType
    _SPOOL = SpoolOptions(SpoolType.SPOOL_SCALE, 1.0, True)
except Exception:
    _SPOOL = None

_STATE = {"OFFLINE": -1, "ONLINE": 0, "ACTIVE": 1, "OVERHEATED": 2}
_CHAR = None
_UNIFORM = DamagePattern(25, 25, 25, 25) if DamagePattern else None


def _item(tid):
    return eos.db.getItem(int(tid))


def _known(tid):
    """True if the PINNED pyfa staticdata knows this typeID.

    A type present in OUR SDE bundle but absent here is pin drift, not an engine
    difference — and silently dropping it (the old behaviour) made the two sides
    compute DIFFERENT fits, manufacturing phantom stat diffs. Callers record the
    miss so run-diff can report it as drift and skip the incomparable fit.
    """
    try:
        return _item(tid) is not None
    except Exception:
        return False


def build_fit(spec):
    """Build the pyfa fit. Returns (fit, dropped) where `dropped` lists every
    typeID the pinned staticdata could not supply."""
    dropped = []

    def _miss(tid, kind):
        dropped.append({"typeID": int(tid), "kind": kind})

    fit = Fit()
    fit.ship = Ship(_item(spec["shipTypeID"]))
    fit.character = _CHAR
    # Implants must be read off the FIT. `appliedImplants` returns
    # character.implants when implantLocation == CHARACTER, and the All-V
    # character has none — the fit's implants would silently do nothing.
    fit.implantLocation = ImplantLocation.FIT
    if _UNIFORM is not None:
        fit.damagePattern = _UNIFORM

    # Subsystems first so the hull's slot layout is correct before modules.
    for s in spec.get("subsystems", []):
        if not _known(s["typeID"]):
            _miss(s["typeID"], "subsystem")
            continue
        try:
            sm = Module(_item(s["typeID"]))
            fit.modules.append(sm)
            sm.owner = fit
        except Exception:
            pass

    if spec.get("modeTypeID"):
        if not _known(spec["modeTypeID"]):
            _miss(spec["modeTypeID"], "mode")
        else:
            try:
                fit.mode = fit.ship.checkModeItem(_item(spec["modeTypeID"]))
            except Exception:
                pass

    for mod in spec.get("modules", []):
        if not _known(mod["typeID"]):
            _miss(mod["typeID"], "module")
            continue
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
            if not _known(mod["chargeTypeID"]):
                _miss(mod["chargeTypeID"], "charge")
            else:
                try:
                    m.charge = _item(mod["chargeTypeID"])
                except Exception:
                    pass

    for d in spec.get("drones", []):
        if not _known(d["typeID"]):
            _miss(d["typeID"], "drone")
            continue
        try:
            dr = Drone(_item(d["typeID"]))
            dr.amount = int(d.get("count", 0))
            dr.amountActive = int(d.get("active", d.get("count", 0)))
            fit.drones.append(dr)
            dr.owner = fit
        except Exception:
            pass

    for f in spec.get("fighters", []):
        if not _known(f["typeID"]):
            _miss(f["typeID"], "fighter")
            continue
        try:
            fg = Fighter(_item(f["typeID"]))
            # `_amount = -1` means "max squadron size", which is what a fitted
            # squadron is; only override when the spec asks for fewer.
            if f.get("count"):
                fg.amount = int(f["count"])
            fg.active = bool(f.get("active", True))
            fit.fighters.append(fg)
            fg.owner = fit
        except Exception:
            pass

    # HandledImplantList.append REMOVES an implant whose slot is already taken
    # (one implant per slot, like the game). Feeding it a slot-colliding set
    # would leave the two engines fitting different implants, so the generator
    # emits one per slot and this only mirrors pyfa's own rule.
    for im in spec.get("implants", []):
        if not _known(im["typeID"]):
            _miss(im["typeID"], "implant")
            continue
        try:
            it = Implant(_item(im["typeID"]))
            fit.implants.append(it)
        except Exception:
            pass

    for b in spec.get("boosters", []):
        if not _known(b["typeID"]):
            _miss(b["typeID"], "booster")
            continue
        try:
            bo = Booster(_item(b["typeID"]))
            fit.boosters.append(bo)
        except Exception:
            continue
        # Side effects are opt-in on BOTH sides (pyfa defaults them off). Set
        # them explicitly rather than trusting the default, so a spec that asks
        # for one gets it and a spec that doesn't provably gets none.
        wanted = set(int(e) for e in (b.get("sideEffects") or []))
        try:
            for se in bo.sideEffects:
                se.active = se.effectID in wanted
        except Exception:
            pass

    return fit, dropped


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
    # Drone control range is a FIT-level extra attribute (base 20km on the ship,
    # increased by Drone Avionics / Advanced Drone Avionics skills), NOT a ship
    # hull attribute — read it from extraAttributes so All-V skills are applied.
    try:
        drone_ctrl = _num(fit.extraAttributes["droneControlRange"])
    except Exception:
        drone_ctrl = None
    drone_ctrl_km = (drone_ctrl / 1000.0) if drone_ctrl else None
    wdps = fit.getWeaponDps(spoolOptions=_SPOOL); ddps = fit.getDroneDps()
    tdps = fit.getTotalDps(spoolOptions=_SPOOL)
    wvol = fit.getWeaponVolley(spoolOptions=_SPOOL)

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
            "droneControlRange": drone_ctrl_km,
        },
    }


def main():
    global _CHAR
    _CHAR = Character.getAll5()
    payload = json.load(sys.stdin)

    # PREFLIGHT: `{"op": "known", "typeIDs": [...]}` answers which of those types
    # the pinned staticdata can actually supply. pyfa's own SDE snapshot trails
    # CCP's by weeks, so a corpus built from OUR bundle can name items this
    # oracle has never heard of (66 event/expired boosters, at the time of
    # writing). Asking FIRST lets the caller leave them out and say so, instead
    # of building fits that come back incomparable — the same reason the
    # `dropped` reporting exists, moved one step earlier.
    if isinstance(payload, dict) and payload.get("op") == "known":
        json.dump({"known": [t for t in payload.get("typeIDs", []) if _known(t)]}, sys.stdout)
        return

    specs = payload
    out = []
    for spec in specs:
        rec = {"id": spec.get("id")}
        try:
            fit, dropped = build_fit(spec)
            rec["stats"] = stats(fit)
            rec["ok"] = True
            if dropped:
                rec["dropped"] = dropped
        except Exception as e:
            rec["ok"] = False
            rec["error"] = repr(e)
        out.append(rec)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
