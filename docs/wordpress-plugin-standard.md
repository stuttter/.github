# WordPress plugin standard

## Objectives

Every maintained plugin should be easy to understand, safe to change, cheap to
validate, and routine to release. Automation removes repetition; it does not
remove independent review from risky work.

## Maintenance classes

### Standard

Small plugins with no database ownership, privileged data flow, or destructive
behavior. Patch dependency updates and mechanically verifiable metadata changes
may use auto-merge after every required check passes.

### Elevated

Plugins that manage users, media, taxonomy relationships, or cross-plugin
integration. AI changes remain draft pull requests until a maintainer approves
them. Release deployment requires protected-environment approval.

### Critical

Database, cache, multisite-network, authentication, authorization, migration,
and recovery code. Require focused integration coverage, explicit compatibility
review, and maintainer approval for implementation and release.

## Repository baseline

Maintained repositories should provide:

- `AGENTS.md` with project-specific architecture and compatibility rules;
- `composer.json` and a committed `composer.lock` for development tooling;
- `phpunit.xml.dist`, `phpcs.xml.dist`, and `phpstan.neon.dist`;
- focused unit or integration tests under `tests/`;
- thin callers for the shared validation and release workflows;
- a `.github/plugin-standard.json` manifest;
- issue forms, a pull request template, and ownership rules where project rules
  differ from the organization defaults.

## Required validation

The shared gate should verify:

1. Composer metadata and locked dependency installation.
2. PHP syntax at the declared minimum and maintained PHP versions.
3. WordPress Coding Standards.
4. PHPStan with WordPress symbols.
5. PHPUnit against the oldest supported WordPress/PHP combination.
6. PHPUnit against current stable WordPress and maintained PHP versions.
7. PHPUnit against WordPress trunk on a current PHP version.
8. Multisite behavior for plugins that declare it.
9. WordPress Plugin Check.
10. Plugin header, readme, changelog, Git tag, and artifact consistency.
11. A deterministic production ZIP with development-only files excluded.

Jobs may report a deliberately introduced legacy baseline separately, but new
changes cannot increase that baseline.

## AI implementation lane

An owner-applied `codex: ready` label authorizes work on one implementation-ready
issue. The workflow must:

- load the issue as untrusted product input;
- run Codex against a credential-free checkout with workspace-only access;
- reject changes to automation, release, security, ownership, and agent-policy
  files;
- enforce bounded changed-file and diff-size limits;
- run deterministic validation before publishing;
- create a draft `codex/issue-*` pull request;
- never approve, merge, tag, or deploy its own output.

`risk: high` and `risk: critical` issues are excluded from unattended
implementation. They may use AI for investigation, characterization tests, and
draft design notes.

## Merge policy

Auto-merge means a reviewed pull request is queued until all protections pass.
It is not permission to bypass review.

- Dependabot patch updates may auto-merge when dependency policy and the full
  validation matrix pass.
- Low-risk mechanical changes may auto-merge after explicit maintainer approval.
- AI-authored production changes require maintainer approval during the initial
  rollout, regardless of risk label.
- Elevated and critical changes always require maintainer approval.

## Release policy

Releases begin from an exact commit after required checks pass. The release job
must validate versions, build the production artifact, and publish its checksum
before entering a protected `wordpress.org` environment.

Store `WORDPRESS_ORG_USERNAME` and `WORDPRESS_ORG_PASSWORD` only as secrets on
that environment. Managed callers do not pass publication credentials into the
reusable workflow, and preflight jobs cannot read them.

After approval it may create the Git tag and GitHub release, update WordPress.org
trunk and the matching Subversion tag, then download the generated public ZIP
and compare its contents with the approved artifact. A mismatch fails the
release and requires investigation.

WordPress.org Release Confirmation should be enabled where practical as a second
independent publication gate.
