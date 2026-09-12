# WordPress plugin standard

## Objectives

Every maintained plugin should be easy to understand, safe to change, cheap to
validate, and routine to release. Automation removes repetition; it does not
remove independent review from risky work.

The fleet-wide definition of autonomous, mechanically safe work lives in
[`autonomy-policy.md`](autonomy-policy.md). Repository risk classes add test and
review requirements; they do not override its fail-closed home-run rubric.

## Maintenance classes

### Standard

Small plugins with no database ownership, privileged data flow, or destructive
behavior. Patch dependency updates and mechanically verifiable metadata changes
may use auto-merge after every required check passes.

### Elevated

Plugins that manage users, media, taxonomy relationships, or cross-plugin
integration. Runtime, data-sensitive, compatibility, and integration changes
require maintainer approval. Proven home-run maintenance may follow the central
autonomy policy.

### Critical

Database, cache, multisite-network, authentication, authorization, migration,
and recovery code. Require focused integration coverage, explicit compatibility
review, and maintainer approval for semantic implementation and release.
Mechanically proven home-run maintenance may follow the central policy without
weakening those requirements.

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
- enforce deterministic path, size, binary, and patch-integrity boundaries
  before publishing;
- create and locally verify a signed commit;
- require GitHub to report that signature as verified before preserving the
  branch or opening a draft `codex/issue-*` pull request;
- never approve, merge, tag, or deploy its own output.

`risk: high` and `risk: critical` issues are excluded from unattended
implementation. They may use AI for investigation, characterization tests, and
draft design notes.

## Merge policy

Auto-merge means an eligible pull request is queued until all protections pass.
It is not permission to bypass review or to substitute author identity for the
evidence required by the home-run rubric.

- Dependabot patch updates may auto-merge when dependency policy and the full
  validation matrix pass.
- Preauthorized mechanical changes may auto-merge only when every item in the
  home-run rubric is mechanically proven.
- Elevated and critical runtime, data-sensitive, security, compatibility, and
  infrastructure changes always require maintainer approval.

Before enabling the Codex issue caller, configure `FLEET_SIGNING_KEY`,
`FLEET_SIGNING_PUBLIC_KEY`, and `FLEET_SIGNING_EMAIL` as secrets available to the
caller. Use a dedicated SSH signing key registered with GitHub. The publishing
job receives these values only after the credential-free implementation job has
produced an inert patch artifact.

## Release policy

Releases begin from an exact commit after required checks pass. The release job
must validate versions, build the production artifact, and publish its checksum
before entering a protected `wordpress.org` environment. Per-release approval is
the default and remains mandatory until centrally reviewed policy explicitly
enables an autonomous release class for that repository.

Store `WORDPRESS_ORG_USERNAME` and `WORDPRESS_ORG_PASSWORD` as organization
Actions secrets with access limited to the inventory's release-enabled
repositories. Managed callers pass exactly those two secrets into the reusable
workflow; broad secret inheritance is not allowed. Do not duplicate the same
names as environment secrets, because environment secrets override passed
secrets in a reusable workflow.

Each release-enabled repository must also have a protected `wordpress.org`
environment. That environment supplies the deployment approval and protected
branch gate, while the centrally managed organization secrets remain the single
credential source. The preflight job does not reference publication credentials,
and the publish job cannot start before the environment gate passes.

After approval it may create the Git tag and GitHub release, update WordPress.org
trunk and the matching Subversion tag, then download the generated public ZIP
and compare its contents with the approved artifact. A mismatch fails the
release and requires investigation.

WordPress.org Release Confirmation should be enabled where practical as a second
independent publication gate.
