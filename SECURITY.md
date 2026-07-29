# Security Policy

## Project status

CodeAtlas is pre-release software under active development. No version is currently supported for production use, and the local execution provider is not a hostile-code sandbox.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/yeegz/CodeAtlas/security/advisories/new). Do not open a public issue for a suspected vulnerability and do not include repository source, tokens, secrets, personal data, or exploit details in public discussions.

Include enough information to reproduce and assess the issue safely:

- affected commit or branch;
- impacted component and trust boundary;
- minimal reproduction steps;
- expected and observed behavior;
- potential data, integrity, or availability impact;
- any temporary mitigation you have identified.

## Current execution boundary

The trusted-local runner executes repository test code as the current host user. Temporary-directory copying, path validation, reduced environment forwarding, process/output limits, and cleanup reduce accidental impact but do not contain deliberately hostile code.

Do not run untrusted repositories until the hosted gVisor execution milestone and its adversarial acceptance tests are complete.

## Security priorities

CodeAtlas treats these as release-blocking classes of defect:

- cross-tenant or private-repository authorization failures;
- shell or argument injection;
- path traversal or symlink escape;
- forged, stale, or incorrectly attributed evidence;
- secret leakage through logs or artifacts;
- generated tests certifying their own claims;
- sandbox, egress, quota, retention, or deletion failures.
