#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInventory } from './sync-plugin-standards.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const organization = 'stuttter';
const actionsAppId = 15368;
const apiHeaders = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10'];

export const settingsUsage = `Usage:
  npm run repository:settings -- audit [all|owner/repository]
  npm run repository:settings -- apply all
`;

function apiArguments(endpoint, method = 'GET', input = false) {
  const args = ['api', '--hostname', 'github.com', '--method', method, ...apiHeaders, endpoint];
  if (input) args.push('--input', '-');
  return args;
}

export function commandArguments(argumentsList) {
  if (argumentsList.length === 1 && ['--help', '-h'].includes(argumentsList[0])) {
    return { help: true, mode: 'audit', requested: 'all' };
  }
  if (argumentsList.length > 2) throw new Error('Expected at most one mode and one repository target.');
  const [mode = 'audit', requested = 'all'] = argumentsList;
  if (!['audit', 'apply'].includes(mode)) throw new Error('Mode must be audit or apply.');
  if (mode === 'apply' && requested !== 'all') {
    throw new Error('Apply mode must reconcile the complete enabled portfolio.');
  }
  return { help: false, mode, requested };
}

export function selectTargets(inventory, requested = 'all') {
  const targets = inventory.repositories.filter((target) =>
    target.enabled && (requested === 'all' || target.repository === requested)
  );
  if (requested !== 'all' && targets.length !== 1) {
    throw new Error(`${requested} is not an enabled portfolio target.`);
  }
  return targets;
}

export function requiredCheckContexts(target) {
  const phpMatrix = target.manifest.php_matrix || [target.manifest.minimum_php];
  const contexts = [
    'validate / Metadata',
    ...phpMatrix.map((version) => `validate / PHP ${version} syntax`),
    'validate / Project quality suite',
  ];

  if (target.checks.phpunit !== false) {
    contexts.push(`validate / Minimum PHP ${target.manifest.minimum_php} tests`);
  }
  if (target.checks.node) {
    contexts.push(`validate / Node ${target.checks.node.version} generated assets`);
  }
  if (target.checks.smoke?.single_site) contexts.push('validate / Single-site smoke');
  if (target.checks.smoke?.multisite) contexts.push('validate / Multisite smoke');
  if (target.integration.plugin_check === true) contexts.push('validate / WordPress Plugin Check');

  if (target.integration.wordpress) {
    const topology = target.manifest.multisite ? 'multisite' : 'single-site';
    contexts.push(
      `validate / WordPress ${target.manifest.minimum_wordpress} / PHP ${target.manifest.minimum_php} / ${topology}`,
      `validate / WordPress stable / PHP 8.4 / ${topology}`,
      `validate / WordPress trunk / PHP 8.4 / ${topology}`,
    );
  }

  contexts.push(...(target.protection?.extra_required_checks || []));
  contexts.push('validate / Production artifact');
  return [...new Set(contexts)].sort((left, right) => left.localeCompare(right));
}

export function desiredRepositorySettings() {
  return {
    allow_auto_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_squash_merge: true,
    delete_branch_on_merge: true,
    security_and_analysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    },
  };
}

export function desiredBranchProtection(target) {
  return {
    required_status_checks: {
      strict: true,
      checks: requiredCheckContexts(target).map((context) => ({ context, app_id: actionsAppId })),
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
      require_last_push_approval: false,
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: false,
  };
}

export function runGitHub(args, input = undefined, runner = spawnSync) {
  const environment = { ...process.env, GH_HOST: 'github.com' };
  const result = runner('gh', args, {
    encoding: 'utf8',
    env: environment,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function request(execute, endpoint, { method = 'GET', input, allowNotFound = false } = {}) {
  const result = execute(apiArguments(endpoint, method, input !== undefined), input);
  if (allowNotFound && result.status !== 0 && /HTTP 404|Not Found/iu.test(result.stderr)) return null;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${method} ${endpoint} failed.`);
  if (result.stdout.trim() === '') return true;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${method} ${endpoint} did not return valid JSON.`);
  }
}

function enabled(value) {
  return value?.enabled === true;
}

function normalizedChecks(protection) {
  return (protection?.required_status_checks?.checks || []).map(({ context, app_id }) => ({ context, app_id })).sort((left, right) => left.context.localeCompare(right.context));
}

export function inspectTarget({ target, execute = runGitHub }) {
  const repository = target.repository;
  const releaseBranch = target.manifest.release_branch || 'main';
  const metadata = request(execute, `repos/${repository}`);
  const errors = [];
  const drift = [];

  if (
    metadata.full_name !== repository ||
    metadata.owner?.login !== organization ||
    metadata.fork !== false ||
    metadata.archived !== false ||
    metadata.default_branch !== releaseBranch
  ) {
    errors.push(`${repository} is not an active owned repository on its declared release branch.`);
  }

  const head = request(execute, `repos/${repository}/commits/${encodeURIComponent(releaseBranch)}`);
  if (!/^[a-f0-9]{40}$/u.test(head.sha ?? '') || head.commit?.verification?.verified !== true) {
    errors.push(`${repository} does not have a GitHub-verified signed default-branch head.`);
  }

  const checkPayload = request(execute, `repos/${repository}/commits/${encodeURIComponent(head.sha || releaseBranch)}/check-runs?per_page=100`);
  if (!Number.isSafeInteger(checkPayload.total_count) || !Array.isArray(checkPayload.check_runs) || checkPayload.total_count !== checkPayload.check_runs.length) {
    errors.push(`${repository} returned incomplete or malformed default-branch check runs.`);
  } else {
    for (const context of requiredCheckContexts(target)) {
      const matching = checkPayload.check_runs
        .filter((check) => check.name === context && check.app?.id === actionsAppId && Number.isSafeInteger(check.id))
        .sort((left, right) => right.id - left.id);
      if (matching.length === 0) errors.push(`${repository} has never reported required check ${context} from GitHub Actions on its current head.`);
      else if (matching[0].conclusion !== 'success') {
        errors.push(`${repository} does not have a successful latest ${context} check from GitHub Actions on its current head.`);
      }
    }
  }

  const rulesets = request(execute, `repos/${repository}/rulesets?includes_parents=true`);
  const signatureRuleIds = rulesets
    .filter((ruleset) => ruleset.enforcement === 'active' && ruleset.target === 'branch')
    .map((ruleset) => ruleset.id)
    .filter(Number.isSafeInteger);
  let hasSignatureRule = false;
  for (const id of signatureRuleIds) {
    const ruleset = request(execute, `repos/${repository}/rulesets/${id}`);
    const exclusions = ruleset.conditions?.ref_name?.exclude;
    const allBranches = ruleset.conditions?.ref_name?.include?.includes('~ALL') &&
      Array.isArray(exclusions) && exclusions.length === 0;
    if (allBranches && ruleset.rules?.some((rule) => rule.type === 'required_signatures')) hasSignatureRule = true;
  }
  if (!hasSignatureRule) errors.push(`${repository} does not have an active signed-commit rule for every branch.`);

  const settings = desiredRepositorySettings();
  for (const key of ['allow_auto_merge', 'allow_merge_commit', 'allow_rebase_merge', 'allow_squash_merge', 'delete_branch_on_merge']) {
    if (metadata[key] !== settings[key]) drift.push(`repository.${key}`);
  }
  if (metadata.security_and_analysis?.secret_scanning?.status !== 'enabled') drift.push('security.secret_scanning');
  if (metadata.security_and_analysis?.secret_scanning_push_protection?.status !== 'enabled') drift.push('security.push_protection');

  const protection = request(execute, `repos/${repository}/branches/${encodeURIComponent(releaseBranch)}/protection`, { allowNotFound: true });
  const desiredProtection = desiredBranchProtection(target);
  const desiredChecks = desiredProtection.required_status_checks.checks;
  if (!protection) {
    drift.push('branch_protection');
  } else {
    if (protection.required_status_checks?.strict !== true) drift.push('branch.strict_checks');
    if (JSON.stringify(normalizedChecks(protection)) !== JSON.stringify(desiredChecks)) drift.push('branch.required_checks');
    if (!enabled(protection.enforce_admins)) drift.push('branch.enforce_admins');
    if (protection.required_pull_request_reviews?.dismiss_stale_reviews !== true) drift.push('branch.dismiss_stale_reviews');
    if (protection.required_pull_request_reviews?.require_code_owner_reviews !== false) drift.push('branch.code_owner_reviews');
    if (protection.required_pull_request_reviews?.required_approving_review_count !== 0) drift.push('branch.approving_reviews');
    if (protection.required_pull_request_reviews?.require_last_push_approval !== false) drift.push('branch.last_push_approval');
    if (protection.restrictions != null) drift.push('branch.restrictions');
    if (!enabled(protection.required_linear_history)) drift.push('branch.linear_history');
    if (!enabled(protection.required_conversation_resolution)) drift.push('branch.conversation_resolution');
    if (enabled(protection.allow_force_pushes)) drift.push('branch.force_pushes');
    if (enabled(protection.allow_deletions)) drift.push('branch.deletions');
    if (enabled(protection.block_creations)) drift.push('branch.block_creations');
    if (enabled(protection.lock_branch)) drift.push('branch.lock_branch');
    if (enabled(protection.allow_fork_syncing)) drift.push('branch.fork_syncing');
  }

  if (metadata.security_and_analysis?.dependabot_security_updates?.status !== 'enabled') {
    drift.push('security.dependabot_updates');
  }

  return { repository, release_branch: releaseBranch, errors, drift: [...new Set(drift)].sort() };
}

export function applyTarget({ target, inspection, execute = runGitHub }) {
  if (inspection.errors.length > 0) throw new Error(`${target.repository} did not pass repository-settings preflight.`);
  const repository = target.repository;
  const branch = target.manifest.release_branch || 'main';
  request(execute, `repos/${repository}`, {
    method: 'PATCH',
    input: `${JSON.stringify(desiredRepositorySettings())}\n`,
  });
  request(execute, `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`, {
    method: 'PUT',
    input: `${JSON.stringify(desiredBranchProtection(target))}\n`,
  });
  request(execute, `repos/${repository}/automated-security-fixes`, { method: 'PUT' });
  return { repository, changed: inspection.drift };
}

function inspectSafely({ target, execute }) {
  try {
    return inspectTarget({ target, execute });
  } catch (error) {
    return {
      repository: target.repository,
      release_branch: target.manifest.release_branch || 'main',
      errors: [`${target.repository} inspection failed: ${error.message}`],
      drift: [],
    };
  }
}

function inspectTargets(targets, execute) {
  return targets.map((target) => inspectSafely({ target, execute }));
}

export function provisionRepositorySettings({ inventory, mode = 'audit', requested = 'all', execute = runGitHub }) {
  if (!['audit', 'apply'].includes(mode)) throw new Error('Mode must be audit or apply.');
  if (mode === 'apply' && requested !== 'all') {
    throw new Error('Apply mode must reconcile the complete enabled portfolio.');
  }
  const targets = selectTargets(inventory, requested);
  const inspections = inspectTargets(targets, execute);
  const errors = inspections.flatMap((inspection) => inspection.errors);
  const report = { mode, requested, inspections, changed: [], apply_errors: [] };
  if (mode === 'audit' || errors.length > 0) return report;

  // Repeat the complete read-only preflight immediately before the first write.
  // A change to repository ownership, signed-head state, rulesets, or checks
  // between the two passes aborts the whole fleet before mutation begins.
  report.revalidation = inspectTargets(targets, execute);
  if (report.revalidation.some((inspection) => inspection.errors.length > 0)) return report;

  targets.forEach((target, index) => {
    try {
      report.changed.push(applyTarget({ target, inspection: report.revalidation[index], execute }));
    } catch (error) {
      report.apply_errors.push({ repository: target.repository, error: error.message });
    }
  });
  report.verification = inspectTargets(targets, execute);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = commandArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(settingsUsage);
    } else {
      const inventory = loadInventory(resolve(repositoryRoot, 'portfolio/plugins.json'));
      const report = provisionRepositorySettings({ inventory, ...options });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      const failures = report.inspections.some((inspection) => inspection.errors.length > 0) ||
        report.revalidation?.some((inspection) => inspection.errors.length > 0) ||
        report.apply_errors.length > 0 ||
        report.verification?.some((inspection) => inspection.errors.length > 0 || inspection.drift.length > 0);
      if (failures) process.exitCode = 2;
      else if (options.mode === 'audit' && report.inspections.some((inspection) => inspection.drift.length > 0)) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
