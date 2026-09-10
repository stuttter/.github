# WordPress plugin portfolio standards

Shared GitHub policy, reusable workflows, release tooling, and visual-system
sources for a portfolio currently hosted in the legacy `stuttter` GitHub
organization. The namespace is infrastructure, not the public brand.

The system is designed to make routine maintenance inexpensive without allowing
automation to approve its own work or publish unverified releases.

## Repository map

- `docs/wordpress-plugin-standard.md` defines the engineering and release tiers.
- `docs/visual-system.md` defines the shared icon and banner language.
- `docs/namespace-migration.md` defines the safe path away from the legacy
  organization name.
- `portfolio/plugins.json` records project-specific compatibility and risk.
- `docs/fleet-synchronization.md` documents safe audit and draft-PR automation.
- `.github/workflows/` contains reusable workflows called by plugin repositories.
- `scripts/` contains deterministic validation and release helpers.

This repository is intentionally public so its community-health files and
reusable workflows can be shared by public repositories in the organization.
