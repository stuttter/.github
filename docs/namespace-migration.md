# GitHub namespace migration

`stuttter` is a legacy hosting namespace, not the portfolio brand. Renaming it
is feasible, but it must be treated as an infrastructure migration rather than
a cosmetic setting change.

## Known GitHub behavior

GitHub redirects existing repository web URLs and Git remotes after an
organization rename. It does not redirect the old organization profile, API
requests containing the old organization name, or old team mentions. The old
namespace can become available to another account, which can invalidate some
repository redirects. Packages, Pages, webhooks, integrations, badges, and
reusable workflow references require explicit inventory and testing.

## Migration rule

Do not rename the organization until all callers can be changed in one bounded
migration window and the desired replacement name has been reviewed.

## Inventory

Before the rename, record and search for:

- Git remotes in every maintained local checkout;
- repository links in plugin headers, readmes, WordPress.org pages, support
  responses, websites, and documentation;
- `uses: stuttter/...` GitHub Actions and reusable workflow references;
- API clients, webhook targets, deploy keys, GitHub Apps, and OAuth settings;
- package and container coordinates;
- GitHub Pages sites and custom domains;
- CODEOWNERS entries and organization/team mentions;
- badges, release-download links, Composer source URLs, and update endpoints.

## Safer sequence

1. Choose a durable, available namespace and a neutral display name.
2. Publish shared automation without hard-coded organization references where
   GitHub permits it, and record unavoidable references in one manifest.
3. Capture an automated link and API inventory; export organization settings.
4. Pause releases and merges for the migration window.
5. Rename the organization, immediately update remotes and reusable workflow
   callers, then verify clone, fetch, issues, releases, Actions, and webhooks.
6. Update WordPress.org and external links in batches and monitor old URLs.
7. Keep a permanent migration report so future maintainers know which redirects
   are expected and which references must never regress.

Creating a second organization and transferring repositories is an alternative,
but it creates a similar link audit and can add permissions and integration
changes. It is not automatically safer than an in-place rename.
