# capsuleers.fitting-engine (`eve-fit-engine`)

Motore di calcolo fitting EVE Online (navi e strutture Upwell) a parità con Pyfa, pubblicato su npm
come `eve-fit-engine`: `FittingDataset` + `Fit` → blocco stat completo. Versione: `package.json`.
Percorsi relativi a questa cartella; per regole di orchestrazione vedi `../CLAUDE.md`.

## Comandi
```bash
npm run build            # tsup → dist/ (ESM + CJS + d.ts), entrambi gli entry
npm run typecheck        # tsc --noEmit (stessa strictness del sito; niente noUncheckedIndexedAccess)
npm run test:pyfa        # suite fixture Pyfa (662 asserzioni) — IL gate di rilascio
npm run test:smoke       # smoke base + ./node
npm run test:drones      # banda droni
npm run diff             # harness differenziale vs pyfa headless (--source=generated|workbench|implants|all, --strict)
npm run diff:setup       # costruisce l'oracle pyfa in .pyfa/ (PYFA_REF=<commit>)
npm run diff:recalibrate # rigenera known-diffs.mjs + PYFA_REF dopo un bump del pin
npm run stacking:build   # rigenera src/stackingPenalised.ts dal pyfa pinnato (--check per verificare)
npm run audit:coverage   # effetti SDE senza handler ("truly silent: 0")
npm run drift            # effects.py di pyfa vs snapshot + handler hardcoded (drift:update aggiorna)
npm run corpus:fetch     # fit reali da EVE Workbench (serve EVEWORKBENCH_API_KEY)
npm run build:data       # SDE CCP → rigenera il bundle data/
```

## Vincoli
- Licenza GPL-3.0-or-later (derivato di Pyfa `eos`, porting diretto ammesso); il sito lo usa solo server-side.
- Entry `.` senza `fs`/`fetch`/`window` e senza dipendenze runtime; il bundle SDE solo in `./node`.
- `dist/` è gitignorato: `npm run build` dopo ogni modifica a `src/`, prima di `test:pyfa`/`diff`.
- **Mai regredire `test:pyfa` 662/0 per far passare `diff`, mai allargare `known-diffs.mjs`.** Modifiche
  all'engine: girare entrambe le suite; un fix che risolve un diff accettato ne cancella la voce nello stesso commit.
- `src/stackingPenalised.ts` è GENERATO (`stacking:build`): mai a mano. Bump del pin pyfa solo con la
  procedura completa di parity.md, mai il solo `PYFA_REF`.
- `corpus:fetch` resta a concorrenza 2; `.workbench/` è cache gitignorata di fit altrui, non ridistribuirla.
- Script del repo via `npm run`, non `node` diretto.
- Script npm nuovi/rinominati, flussi di validazione/rilascio o invarianti di parità cambiati →
  aggiorna `CONTRIBUTING.md` e questo file nello stesso PR.
- Emblema: non ritoccarlo qui (vedi brand.md).

## Aree (leggi solo se il task le tocca)
| area | file | leggi se |
|---|---|---|
| engine | docs/claude/engine.md | tocchi `src/`: orchestratore, modificatori, stacking, `derived/`, entry point |
| parità | docs/claude/parity.md | tocchi `test/`, known-diffs, oracle/pin pyfa, workflow di parità |
| rilascio | docs/claude/release.md | pubblichi, tocchi CI di release o refresh SDE |
| marchio | ../docs/claude/brand.md | tocchi l'emblema |
