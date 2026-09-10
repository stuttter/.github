# Fleet standards synchronization

The fleet synchronizer keeps a deliberately small set of mechanical files in
known plugin repositories aligned with this repository. It is opt-in: a target
must have an enabled record in `portfolio/plugins.json`. Discovery by owner,
topic, name pattern, or search result is intentionally not supported.

## Ownership boundary

The synchronizer manages only these paths:

- `.github/plugin-standard.json` when it does not exist;
- `.github/workflows/ci.yml`;
- `.github/workflows/release.yml`;
- `.github/dependabot.yml`.

Managed YAML begins with a visible ownership marker. An existing YAML file
without that marker is repository-owned and produces a conflict instead of an
update. An existing plugin manifest is never overwritten. It is validated and
compared with the inventory; differences require a deliberate compatibility
decision in a normal pull request.

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

Protect `.github/workflows/`, `.github/plugin-standard.json`,
`.github/dependabot.yml`, `.github/CODEOWNERS`, `AGENTS.md`, release tooling, and
security policy with repository rules and required owner review. Protect the
release branch from direct pushes and require signed commits and successful CI.
Keep the `fleet-standards` and `wordpress.org` environments reviewer-gated, and
limit their secrets to the jobs that require them.

Fleet automation does not approve its own protected-file changes. Changes to
the templates, synchronizer, reusable workflows, inventories, signing policy,
or environment configuration belong in focused pull requests in this repository
before they can propagate to plugin repositories.

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
