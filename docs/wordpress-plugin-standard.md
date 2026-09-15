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
10. Plugin header, readme short description, changelog, Git tag, and artifact
    consistency.
11. A deterministic production ZIP with development-only files excluded.

For WordPress.org plugins, `readme.txt` must contain exactly one plain-text
short description after the header fields and before `== Description ==`. It
must be non-empty, contain no markup, and be no longer than 150 characters.
Despite the importer calling this a section, do not add a
`== Short Description ==` heading; that is not the WordPress.org readme format.

Jobs may report a deliberately introduced legacy baseline separately, but new
changes cannot increase that baseline. Pull requests may introduce the canonical
`phpcs-baseline.json` and `phpstan-baseline.neon` files when the base revision
has none. After introduction, the shared gate permits removed allowances, lower
counts, and the conservative PHPStan narrowing relation documented below. It
rejects new PHPCS keys, broader or unrecognized PHPStan rewrites, and count
increases without executing files from the base revision. PHPStan
baselines must use the complete canonical generated form: one
`parameters.ignoreErrors` list containing only an explicitly quoted message,
optional string identifier, positive integer count, and string path. Quoted
values use single-quoted NEON or JSON-compatible double quotes; unquoted path
and identifier values are limited to plain filename/token characters. Inline or
unbounded ignores, typed values, collections, includes, alternate collections,
and unrelated trailing configuration fail closed.

PHPStan message-pattern narrowing recognizes only `#^literal#`,
`#^literal$#`, and `#^literal.*$#`. In this deliberately small grammar, regular
expression metacharacters must be backslash-escaped as literals, and backslash
escapes are accepted only for non-alphanumeric characters. A head prefix must
extend one unique base prefix, keep the same path, preserve or add (but never
change or remove) an identifier, and consume no more than the base entry's
remaining count. Multiple narrowed entries may split one base count, but their
combined count cannot exceed it. An exact base remains exact; a `.*` base may
narrow only to a longer `.*` or exact pattern; and a start-anchored prefix may
narrow to any recognized longer form. This keeps newline-sensitive PCRE
matching within the subset relation. Character classes, alternation, quantified
groups, lookarounds, backreferences, modifiers, ambiguous parent matches, and
every other regex rewrite are rejected rather than guessed to be narrower.

On initial introduction, the head must already contain a valid corresponding
Composer script and conventional analyzer configuration. The command must name
the analyzer as its first command token or name a regular `bin/` or `scripts/`
runner containing an explicit reference to its locked `vendor/bin/` analyzer.
When a baseline
already exists on the pull request base, the corresponding
Composer analyzer command, conventional analyzer configuration, and directly
named `bin/` or `scripts/` runner must remain byte-for-byte unchanged. This
prevents a pull request from bypassing the gate by removing or replacing the
analyzer. That narrow check does not recursively interpret helper files loaded
by a runner or configuration, dependency changes that alter the resolved
analyzer executable, or analyzer behavior changed outside the repository.
For an initial baseline, it also cannot prove that arbitrary new runner code
executes a vendor path merely mentioned in a comment or string. Initial baseline
introductions therefore require maintainer review and are not an autonomous
home-run change. After merge, the runner is protected byte for byte.
Repositories must protect those transitive analysis inputs through ownership
rules, dependency review, and the locked toolchain checks in the quality suite.

### Trusted project checks

The immutable portfolio inventory—not a pull-request-edited plugin manifest—
explicitly enrolls existing PHPUnit suites and selects optional generated-asset
and live-smoke checks. A `checks.phpunit` enrollment adds a minimum-PHP matrix
cell, fixes the Composer manifests, conventional `phpunit.xml.dist`
configuration, and bootstrap or runner hashes, and requires `phpunit/phpunit`
in the lockfile. CI installs the
locked tools without Composer scripts and invokes `vendor/bin/phpunit` directly;
the repository's Composer `test` alias is never trusted. PHPUnit must emit a
bounded, valid JUnit document containing at least one non-skipped test.
Repositories without an established suite declare `phpunit: false`; the
inventory must not imply coverage that does not exist.

An approved Node.js profile selects Node.js 22 or 24 and records the exact
package script-name-to-command map, including `build:check` and every transitive
npm alias it invokes. The package manifest, lockfile, and every local executable
or configuration file in the approved command closure are
protected by SHA-256; extra or changed package scripts fail closed. CI installs
dependencies with `npm ci --ignore-scripts`, and credential-free release checks
repeat both the contract verification and check before a separate artifact job
runs. Approved commands use a small non-shell grammar: declared npm aliases,
local Node helpers, fixed PostCSS input/output/environment/configuration
arguments, and `git diff --exit-code --` with fixed paths, joined only by `&&`.
PostCSS configuration directory arguments bind to and hash their conventional
`postcss.config.js` file.
Quoting, substitution, redirection, globbing, pipelines, other shell punctuation,
and unapproved executables fail closed. Every repository-relative executable,
source, configuration, and generated-output path in that command closure must
have a central SHA-256 contract. An approved smoke profile names individual `bin/` or
`tests/` shell scripts for single-site or multisite behavior and records the
SHA-256 of each entry point, PHP payload, and transitive local helper. Each smoke
script runs on a fresh matrix runner with read-only repository permissions, no
persisted checkout credential, no release secrets, and no shell evaluation of
its path.
Missing or changed manifests, lockfiles, package commands, configuration files,
bootstrap files, smoke entry points, or helpers fail the declared check.

Smoke scripts own their disposable WordPress setup and teardown until the
centrally maintained WordPress-version environments described in issue #8 are
available. Their dedicated runners provide isolation between smoke profiles;
they must not depend on state from another matrix cell.

### WordPress runtime gates

The immutable portfolio inventory enables WordPress Plugin Check and real
WordPress integration independently for each repository. The plugin checkout's
manifest cannot select commands, paths, WordPress sources, PHP versions, or
topology. WordPress Plugin Check scans the deterministic production build and
rejects repository-controlled wp-env configuration before starting its isolated
environment.

A declared WordPress integration profile always runs the fixed
`tests/integration/smoke.php` entry point against the manifest's oldest
supported WordPress and PHP versions, current stable WordPress on PHP 8.4, and
WordPress trunk on PHP 8.4. The manifest's existing `multisite` value selects
the topology for every cell. The immutable inventory binds that fixed payload
to its reviewed SHA-256 digest; missing, changed, symbolic-link, or misplaced
smoke tests fail the declared profile rather than silently skipping it.

The integration runner installs an exact locked wp-env runtime, builds the
plugin through the same deterministic artifact script, maps only the built
plugin and fixed smoke-test directory, and destroys its environment after each
matrix cell. A source-hash-bound compatibility patch corrects wp-env's legacy
WordPress configuration anchor: current Docker images use modern spacing in
`wp-config.php` even when the selected WordPress source predates 5.1. Any
upstream source drift rejects that patch and requires review. These jobs have
no repository permissions, persist no checkout
credential, and receive no secrets. WP Media Categories and WP User Activity
are the initial single-site and multisite pilots; other repositories remain
inert until their central profile is deliberately enabled.

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

Releases begin from an exact commit after required checks pass. Project dependency
installation and project code execution happen only in a credential-free checks
job. A fresh artifact job then checks out the exact commit, re-verifies the release
branch and central inventory binding, and builds the production archive from Git
objects without installing dependencies or executing repository code. Publishing
uses only that uploaded archive and its checksum before entering a protected
`wordpress.org` environment. Per-release approval is
the default and remains mandatory until centrally reviewed policy explicitly
enables an autonomous release class for that repository.

Store `WORDPRESS_ORG_USERNAME` and `WORDPRESS_ORG_PASSWORD` only as Stuttter
organization Actions secrets with selected-repository visibility restricted to
the centrally approved release-managed repositories. Do not create repository
or environment copies. Repository copies override organization secrets while
the caller is evaluated, and environment aliases can override mapped inputs
inside the publish job. Managed callers explicitly map the canonical names to
the immutable reusable workflow's distinct `STUTTTER_WORDPRESS_ORG_USERNAME` and
`STUTTTER_WORDPRESS_ORG_PASSWORD` inputs and never use `secrets: inherit`. The
different callee names keep the organization credential handoff distinct from
the publish step's conventional shell variable names.
Organization secrets are repository-accessible; the protected
environment gates the central publish job rather than access by every workflow
in the repository. Protect all workflow files accordingly, and never reference
the credentials outside that gated publish job.

After approval it may create the Git tag and GitHub release, update WordPress.org
trunk and the matching Subversion tag, then download the generated public ZIP
and compare its contents with the approved artifact. A mismatch fails the
release and requires investigation.

WordPress.org Release Confirmation should be enabled where practical as a second
independent publication gate.
