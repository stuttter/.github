# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private
vulnerability reporting in the affected repository. If that is unavailable,
contact the repository owner privately through their GitHub profile.

Include the affected plugin and version, security impact, minimum reproduction,
required WordPress configuration, and sanitized evidence. Never include real
credentials, personal information, production database contents, or another
person's data.

## Automation and releases

Reports involving GitHub Actions, dependency compromise, WordPress.org
credentials, release tags, generated artifacts, or unauthorized publication are
security issues. Release credentials must remain limited to protected deployment
jobs and must never be available to AI implementation jobs or pull request code.

Security fixes are normally applied to the current release line. Older versions
may be unsupported when WordPress or PHP compatibility makes a safe backport
impractical.
