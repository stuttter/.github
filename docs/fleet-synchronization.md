# Fleet standards synchronization

The fleet synchronizer keeps a deliberately small set of mechanical files in
known plugin repositories aligned with this repository. It is opt-in: a target
must have an enabled record in `portfolio/plugins.json`. Discovery by owner,
topic, name pattern, or search result is intentionally not supported.

## Ownership boundary

The synchronizer manages only these paths:

- `.github/plugin-standard.json` when it does not exist;
- `.github/skills/code-review/SKILL.md` for enabled repositories;
- `.github/workflows/ci.yml`;
- `.github/workflows/release.yml`;
- `.github/dependabot.yml`.

Managed YAML begins with a visible ownership marker. The review skill carries
the same marker as a comment inside its YAML frontmatter so GitHub Copilot can
parse the required skill metadata. An existing managed-path file without its
expected marker is repository-owned and produces a conflict instead of an
update. Files beside the exact managed skill path, including repository-specific
skills, are not changed. An existing plugin manifest is never overwritten. It
is validated and compared with the inventory; differences require a deliberate
compatibility decision in a normal pull request.

The tool does not delete files, execute plugin code, alter dependencies, merge,
tag, release, or change repository settings.

## Local audit and application

Audit is the default operating posture. It writes JSON to standard output and
uses these exit codes:

- `0`: clean;
- `1`: managed drift or missing files;
- `2`: conflict, invalid inventory, or unsafe input.

```sh
node scripts/sync-plugin-standards.mjs \
  --mode audit \
  --repository stuttter/wp-user-groups \
  --repo-dir ../wp-user-groups \
  --policy-ref "$(git rev-parse HEAD)"
```

Use `--mode apply` only in a disposable branch or checkout. Apply mode creates
missing files and updates marked files, but still stops on repository-owned
content or manifest disagreement.

## GitHub workflow

`Fleet standards` runs a weekly audit and can be dispatched manually for one
inventory target or all enabled targets. `audit` has read-only permissions and
does not load fleet credentials. `propose` enters the protected
`fleet-standards` environment and creates one focused draft pull request per
repository that has drift.

Every generated caller pins the shared reusable workflow to the full commit SHA
of the fleet-policy checkout running the synchronizer. The called workflow uses
`job.workflow_sha` to load validation and release policy from that same immutable
revision. Example callers contain an all-zero fail-closed placeholder until a
reviewed policy commit exists; never replace it with a branch or mutable tag.

Each audit writes a Markdown job summary and uploads its complete JSON result as
a 14-day workflow artifact. Missing or stale managed files are reported as
ordinary drift without making the scheduled job fail. Conflicts, invalid policy,
and unsafe input remain hard failures, with their diagnostics included in the
summary and artifact.

Before enabling proposal mode, configure the protected environment with a
required reviewer and these environment secrets:

- `FLEET_GITHUB_TOKEN`: a fine-grained token limited to the inventoried
  repositories with contents and pull-request write access;
- `FLEET_SIGNING_KEY`: a dedicated SSH signing private key;
- `FLEET_SIGNING_PUBLIC_KEY`: its OpenSSH public key, registered with GitHub as
  a signing key;
- `FLEET_SIGNING_EMAIL`: the email attached to the corresponding GitHub SSH
  signing key.

The workflow refuses forks, archived repositories, and owners other than
`stuttter`. It signs and locally verifies the commit, pushes a unique branch,
then checks GitHub's verification result before opening a draft pull request.
If GitHub does not report a verified signature, the workflow removes its new
branch and stops. Any later failure before the draft pull request is created also
attempts to remove the pushed automation branch. Proposal pull requests do not
approve or merge themselves.

## Staged adoption

Do not add the managed marker to an existing repository file mechanically. An
unmarked file is repository-owned, even when it happens to resemble a fleet
template, and the synchronizer will report it as a conflict.

Adopt one repository in a normal, owner-reviewed pull request:

1. audit the repository and record every conflict;
2. compare each repository-owned file with its proposed fleet template;
3. preserve intentional local behavior in shared policy or a documented
   project-specific input;
4. replace only the files approved for central ownership, including the managed
   marker; and
5. rerun audit and the repository's full CI before merging.

The first adoption pull request establishes ownership; later fleet runs may
update only those marked files. A conflict must never be resolved by overwriting
the local file merely to make the audit green.

## Protected files and settings

Protect `.github/workflows/`, `.github/skills/code-review/SKILL.md`,
`.github/plugin-standard.json`, `.github/dependabot.yml`, `.github/CODEOWNERS`,
`AGENTS.md`, release tooling, and security policy with repository rules and
required owner review. Protect the release branch from direct pushes and require
signed commits and successful CI.
Keep the `fleet-standards` and `wordpress.org` environments reviewer-gated, and
limit organization credentials to the selected repositories and pinned workflow
jobs that require them.

Fleet automation does not approve its own protected-file changes. Changes to
the templates, synchronizer, reusable workflows, inventories, signing policy,
or environment configuration belong in focused pull requests in this repository
before they can propagate to plugin repositories.

## Release environments

WordPress.org credentials are Stuttter organization Actions secrets with
selected-repository visibility. Their allowlist must exactly match the enabled,
release-managed WordPress.org repositories in `portfolio/plugins.json`. Managed
callers explicitly map these two organization secrets to the distinct reusable
workflow inputs `STUTTTER_WORDPRESS_ORG_USERNAME` and
`STUTTTER_WORDPRESS_ORG_PASSWORD`. Repository and environment credential copies
are forbidden. A repository secret with either canonical name would override
the organization secret while the caller is evaluated, while an environment
secret using either `STUTTTER_WORDPRESS_ORG_*` input name would shadow the mapped
secret inside the publish job. Provisioning fails closed for either case.
Callers must not use `secrets: inherit`. An
organization secret is available to workflows in every selected repository, so
the environment is not a repository-wide secret-access boundary. The immutable
central workflow references the credentials only in its publish job, and that
job remains blocked by the fixed `wordpress.org` environment gate. Protect the
managed caller and all workflow files from unreviewed changes.

Create the environment in GitHub first, require JJJ's review, disable
administrator bypass, and restrict deployment to the inventory's exact release
branch. Keep WordPress.org credentials only at organization scope. Repository
or environment copies must be removed before audit or apply can succeed. Then use
`scripts/provision-release-environments.mjs` to audit or rotate credentials
without copying values into files or command arguments. The script
selects only enabled WordPress.org release targets from the validated inventory,
rejects forks, archives, owner drift, branch drift, administrator bypass,
incomplete API results, unexpected deployment policies, and any repository or
environment credential copies. The provisioner also preserves stronger wait,
self-review, and reviewer protections already present.

Supply `WORDPRESS_ORG_USERNAME` and `WORDPRESS_ORG_PASSWORD` through a trusted
secret provider such as `op run`. GitHub CLI must target `github.com` and have
enough access to inspect repository and environment secrets and manage Stuttter
organization Actions secrets. A classic token needs the `repo` and `admin:org`
scopes; the current everyday token may not include `admin:org`. Keep any
1Password environment template outside the repository.

Run `npm run release:provision -- audit all` first; audit mode never writes and
may target one repository for diagnosis. Apply mode always reconciles the full
approved allowlist, so its only valid target is `all`. It inspects every target
before the first write, sets both organization secrets with selected-repository
visibility through standard input, and verifies their names and exact scope.
This metadata verification cannot prove either credential value. Apply reports
each environment it prepared and every confirmed mutation, including work
completed before a later failure. It never deletes secrets. Run
`npm run release:provision -- --help` for the compact operator reminder.

GitHub does not provide an atomic multi-secret or multi-repository update. The
structured report identifies prepared targets, confirmed changes, the failure,
and pending repositories. Rerun the same apply to converge; secret values are
never returned.

There is no trustworthy read-only authentication probe for the WordPress.org
Subversion credentials: repository reads and HTTP capability requests are
public and do not validate the supplied username or password. A normal protected
release therefore provides the first real credential test. A wrong value fails
the release; it does not justify a narrower fallback copy.

## Adding a plugin

Inspect the plugin first. Preserve its actual minimum versions, release branch,
multisite behavior, WordPress.org status, and risk class. Add those facts to
`portfolio/plugins.json`, validate locally, and run an audit for only that
repository. An inventory entry is policy, not an inferred default.

New targets begin disabled. In a separate reviewed change, select only the
caller paths deliberately adopted in `managed_paths` and enable the target.
When that change reaches the protected default branch, the workflow injects its
own exact commit SHA into generated callers, so template code and release
authorization always come from the same inventory revision.
