# Security Review

Last reviewed: 2026-05-23

## Current Controls

- GitHub secret scanning and push protection are enabled.
- Gitleaks scans full repository history in CI.
- CodeQL scans JavaScript and TypeScript in CI.
- OSV scans the pnpm lockfile weekly and on pull requests.
- Production dependency audit fails CI on high severity advisories.
- Dependabot is configured for npm and GitHub Actions updates.

## Current Dependency Posture

`pnpm audit --prod --audit-level=high` passes. OSV currently reports two medium findings in the lockfile after patched transitive overrides for `glob`, `picomatch`, `file-type`, `qs`, `tmp`, and `webpack`.

Known follow-up:

- Plan a NestJS 11 migration branch to address framework transitive findings cleanly.
- Keep the `ajv` finding scoped to tooling until the ESLint dependency path can be upgraded. A global `ajv` override breaks ESLint's config loader.
- Keep OSV visible in CI while the migration is staged, but do not block all PRs on currently non-high findings.
- Review Dependabot security PRs weekly. Some security updates may require major framework/tooling upgrades rather than one-package bumps.

## Open-Source Reporting

Use private GitHub security advisories for vulnerabilities and leaked secrets. Public issues should never include bot tokens, SnapTrade keys, account numbers, brokerage credentials, signed URLs, raw webhook bodies, database URLs, or Redis URLs.

TradePing does not currently offer a paid bounty. Good-faith reports are welcome under the scope and safe-harbor rules in `SECURITY.md`.
