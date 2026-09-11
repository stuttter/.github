# Portfolio autonomy policy

Automation is judged by what a change does and what can prove it safe, not by
whether a human, AI, or dependency bot authored it. This policy applies to every
owned, non-fork repository enrolled in the portfolio.

## Home-run rubric

A pull request may merge without a new human decision only when every statement
below is mechanically proven:

- the change belongs to a centrally preauthorized class;
- the complete diff is mechanical, reversible, and behavior-preserving;
- no protected path, dependency policy, permission, secret, workflow, release
  policy, compatibility floor, public API, stored data, or generated public
  asset changes;
- all required checks exist, ran, and passed; a missing check is a failure;
- the exact head commit has a verified signature, and the allowed merge method
  plus signed-commit ruleset guarantee signed protected-branch history;
- an independent automated review reports no unresolved findings;
- every review conversation is answered and resolved;
- the branch is current with its protected target and merge protection has not
  been bypassed; and
- the resulting commit cannot publish, deploy, tag, broaden access, or modify
  the rule that classified it.

The first eligible classes are narrowly bounded shared-file synchronization,
format-only corrections, generated-file refreshes whose source and output are
both deterministic, and allowlisted patch-level development dependency updates.
A label or trusted bot identity is never sufficient evidence by itself.

### Guarded development dependencies

A development-only dependency update may qualify when an independent classifier
proves that it does not add a direct dependency, move a package into production,
introduce an install or lifecycle script, change an action or workflow, touch a
protected path, weaken an engine or compatibility constraint, or add a license
or vulnerability regression. Patch updates may be centrally preauthorized;
minor updates require an explicit repository opt-in, and major updates require
a human decision.

The repository must install from a clean lockfile, run its complete required
matrix, and rebuild every public artifact. Shipped artifacts must be
byte-for-byte identical unless an approved change explicitly owns their output.
Lockfile changes are reviewed as executable supply-chain input, not treated as
harmless noise. GitHub Actions updates remain sensitive because they replace
privileged executable code even when a bot authored them.

The initial classifier is deliberately narrower: it freezes dependency-graph
membership, binds npm tarballs to their exact package name and version, and
requires an existing Composer package to retain its canonical GitHub repository.
New transitive packages and repository migrations stop for review until an
independent registry-attestation gate is available.

## Human-decision changes

A human decision remains required for runtime behavior, user-visible behavior,
data writes or migrations, authentication or authorization, security policy,
new capabilities, public APIs, minimum-version changes, dependency-policy
exceptions, workflow permissions, credentials, ownership, agent guidance,
release policy, and anything that fails or falls outside the rubric.

Elevated and critical repositories may still use autonomous work for a proven
home-run diff. Their runtime, data-sensitive, security, compatibility, and
infrastructure changes remain human-gated.

## Release progression

Packaging is not publication. Automation may build a deterministic production
artifact from an exact verified commit, validate its contents, produce checksums
and release notes, and prepare a draft GitHub release without a human decision.

Publication starts disabled. It may be enabled by centrally reviewed policy for
a narrow release class only after the repository proves signed lineage, complete
required CI, version and changelog consistency, deterministic artifact contents,
and post-publication verification. Compatibility changes, migrations, security
releases, first releases under the policy, and any anomalous artifact remain
human-gated.

After every autonomous merge or publication, a read-only audit must verify the
resulting protected-branch commit, tag, and artifact. A missing verified
signature or lineage mismatch stops later automation and opens an actionable
incident; it is never normalized as expected drift.

## Fail-closed operation

Missing configuration, absent tests, skipped checks, stale branches, unsigned
commits, unresolved review, ambiguous classification, or unavailable evidence
make a change ineligible. Automation must stop safely and leave an actionable
record; it must never downgrade the result to a warning or infer approval.
