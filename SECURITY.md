# Security Policy

## Supported versions

`eve-fit-engine` follows a rolling-release model on npm. **Only the latest
published version is supported.** Please reproduce any issue against the most
recent release before reporting it — older versions are not back-patched.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Report privately, through either channel:

- **GitHub Security Advisories** — use the
  [*Report a vulnerability*](https://github.com/WilliamFalci/capsuleers.fitting-engine/security/advisories/new)
  button on this repository (preferred).
- **Email** — [info@capsuleers.app](mailto:info@capsuleers.app).

Please include:

- a description of the issue and its impact,
- the package version (`eve-fit-engine@x.y.z`) and Node.js version,
- a minimal reproduction (a fit input + the call you made),
- any stack traces or logs.

We aim to acknowledge a report within **72 hours** and to provide a remediation
plan or fix timeline within **7 days**. Coordinated disclosure is appreciated:
please give us a reasonable window to ship a fix before any public write-up.

## Scope

This is a pure, framework-free computation library (Pyfa-parity fitting math)
that consumers import server- or client-side. Things especially worth reporting:

- crashes, unbounded resource consumption (CPU / memory), or denial of service
  triggered by crafted fit input passed to the public API,
- prototype pollution or unsafe handling of attacker-controlled input,
- vulnerabilities introduced through the dependency tree (`npm audit` findings
  with a demonstrable path through this package).

### Out of scope

- Incorrect stat numbers / Pyfa-parity mismatches — those are **correctness
  bugs**, not security issues; open a normal GitHub issue (see
  [CONTRIBUTING.md](CONTRIBUTING.md)).
- The bundled SDE data being out of date — that is a maintenance stream, see
  [MAINTENANCE.md](MAINTENANCE.md).
- Reports requiring a compromised build environment or physical access.
- Missing best-practice hardening with no demonstrable impact.
