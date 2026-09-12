#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInventory } from './sync-plugin-standards.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environmentName = 'wordpress.org';
const reviewerLogin = 'JJJ';
const secretNames = ['WORDPRESS_ORG_USERNAME', 'WORDPRESS_ORG_PASSWORD'];
const apiHeaders = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10'];

function apiArguments(endpoint, method = 'GET', input = false) {
  const args = ['api', '--hostname', 'github.com', '--method', method, ...apiHeaders, endpoint];
  if (input) args.push('--input', '-');
  return args;
}

function collection(payload, key, context) {
  const items = payload[key];
  if (!Array.isArray(items) || !Number.isSafeInteger(payload.total_count) || payload.total_count !== items.length) {
    throw new Error(`${context} was incomplete or malformed.`);
  }
  return items;
}

function parseJson(output, context) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${context} did not return valid JSON.`);
  }
}

export function selectReleaseTargets(inventory, requested = 'all') {
  const targets = inventory.repositories.filter((target) =>
    target.enabled &&
    target.managed_paths.includes('release') &&
    target.manifest.wordpress_org === true &&
    (requested === 'all' || target.repository === requested)
  );
  if (requested !== 'all' && targets.length !== 1) {
    throw new Error(`${requested} is not an enabled WordPress.org release target.`);
  }
  return targets;
}

export function releaseReviewerId(metadata) {
  if (metadata.login !== reviewerLogin || !Number.isSafeInteger(metadata.id) || metadata.id <= 0) {
    throw new Error('The fixed JJJ release reviewer identity could not be verified.');
  }
  return metadata.id;
}

export function commandArguments(argumentsList) {
  if (argumentsList.length > 2) {
    throw new Error('Expected at most one mode and one repository target.');
  }
  const [mode = 'audit', requested = 'all'] = argumentsList;
  if (!['audit', 'apply'].includes(mode)) throw new Error('Mode must be audit or apply.');
  return { mode, requested };
}

function normalizedReviewers(reviewers) {
  return reviewers
    .map(({ type, reviewer, id }) => ({ type, id: reviewer?.id ?? id }))
    .sort((left, right) => left.type.localeCompare(right.type) || left.id - right.id);
}

export function protectedEnvironment(reviewerId, current = null) {
  if (!Number.isSafeInteger(reviewerId) || reviewerId <= 0) {
    throw new Error('The release reviewer ID must be a positive integer.');
  }
  const reviewerRule = current?.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  const waitRule = current?.protection_rules?.find((rule) => rule.type === 'wait_timer');
  const reviewers = normalizedReviewers(reviewerRule?.reviewers || []);
  if (!reviewers.some((reviewer) => reviewer.type === 'User' && reviewer.id === reviewerId)) {
    reviewers.push({ type: 'User', id: reviewerId });
  }
  reviewers.sort((left, right) => left.type.localeCompare(right.type) || left.id - right.id);
  return {
    wait_timer: waitRule?.wait_timer || 0,
    prevent_self_review: reviewerRule?.prevent_self_review === true,
    reviewers,
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
}

export function currentEnvironmentConfiguration(current) {
  const reviewerRule = current?.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  const waitRule = current?.protection_rules?.find((rule) => rule.type === 'wait_timer');
  const branchPolicy = current?.deployment_branch_policy;
  return {
    wait_timer: waitRule?.wait_timer || 0,
    prevent_self_review: reviewerRule?.prevent_self_review === true,
    reviewers: normalizedReviewers(reviewerRule?.reviewers || []),
    deployment_branch_policy: branchPolicy ? {
      protected_branches: branchPolicy.protected_branches === true,
      custom_branch_policies: branchPolicy.custom_branch_policies === true,
    } : null,
  };
}

export function githubChildEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  const credentials = secretNames.map((name) => environment[name]).filter(Boolean);
  if (credentials.some((credential) => 'github.com'.includes(credential))) {
    throw new Error('A WordPress.org credential conflicts with the required GitHub host value.');
  }
  for (const [name, value] of Object.entries(childEnvironment)) {
    if (
      secretNames.includes(name) ||
      (typeof value === 'string' && credentials.some((credential) => value.includes(credential)))
    ) {
      delete childEnvironment[name];
    }
  }
  childEnvironment.GH_HOST = 'github.com';
  return childEnvironment;
}

export function redactCredentials(value, environment = process.env, additionalCredentials = []) {
  let redacted = value;
  const credentials = [...secretNames
    .map((name) => environment[name])
    .filter(Boolean), ...additionalCredentials.filter(Boolean)]
    .sort((left, right) => right.length - left.length);
  for (const credential of credentials) {
    redacted = redacted.replaceAll(credential, '[REDACTED]');
  }
  return redacted;
}

export function githubFailure(result, args, environment = process.env) {
  const detail = result.stderr?.trim() || result.error?.message || '';
  return redactCredentials(detail, environment) || `gh ${args[0]} failed with status ${result.status}.`;
}

export function runGitHub(args, input = undefined, runner = spawnSync, environment = process.env) {
  const result = runner('gh', args, {
    encoding: 'utf8',
    env: githubChildEnvironment(environment),
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(githubFailure(result, args, environment));
  }
  return result.stdout;
}

export function inspectReleaseEnvironment({ target, reviewerId, execute = runGitHub }) {
  const repository = target.repository;
  const releaseBranch = target.manifest.release_branch || 'main';
  const errors = [];
  const metadata = parseJson(execute(apiArguments(`repos/${repository}`)), `${repository} metadata`);
  if (
    metadata.full_name !== repository ||
    metadata.owner?.login !== 'stuttter' ||
    metadata.fork !== false ||
    metadata.archived !== false
  ) {
    errors.push(`${repository} is not an active, owned Stuttter repository.`);
  }
  if (metadata.default_branch !== releaseBranch) {
    errors.push(`${repository} default branch does not match its release branch.`);
  }

  const environmentsPayload = parseJson(
    execute(apiArguments(`repos/${repository}/environments?per_page=100`)),
    `${repository} environments`,
  );
  const environments = collection(environmentsPayload, 'environments', `${repository} environments`);
  const current = environments.find((environment) => environment.name === environmentName) || null;
  let policies = [];
  let configuredSecrets = [];
  let validProtectionMetadata = true;
  if (!current) {
    errors.push(`${repository} is missing its protected ${environmentName} environment.`);
  } else {
    if (current.can_admins_bypass !== false) {
      errors.push(`${repository} permits administrators to bypass ${environmentName} protection rules.`);
    }
    const allowedRules = new Set(['required_reviewers', 'wait_timer', 'branch_policy']);
    if (current.protection_rules.some((rule) => !allowedRules.has(rule.type))) {
      errors.push(`${repository} has unsupported ${environmentName} protection rules.`);
    }
    for (const type of allowedRules) {
      if (current.protection_rules.filter((rule) => rule.type === type).length > 1) {
        errors.push(`${repository} has duplicate ${environmentName} ${type} protection rules.`);
        validProtectionMetadata = false;
      }
    }
    const reviewerRule = current.protection_rules.find((rule) => rule.type === 'required_reviewers');
    const waitRule = current.protection_rules.find((rule) => rule.type === 'wait_timer');
    const malformedReviewer = reviewerRule?.reviewers?.some(({ type, reviewer }) =>
      !['User', 'Team'].includes(type) || !Number.isSafeInteger(reviewer?.id) || reviewer.id <= 0
    );
    if (malformedReviewer || (reviewerRule && typeof reviewerRule.prevent_self_review !== 'boolean')) {
      errors.push(`${repository} has malformed ${environmentName} reviewer metadata.`);
      validProtectionMetadata = false;
    }
    if (waitRule && (!Number.isSafeInteger(waitRule.wait_timer) || waitRule.wait_timer < 0 || waitRule.wait_timer > 43200)) {
      errors.push(`${repository} has malformed ${environmentName} wait-timer metadata.`);
      validProtectionMetadata = false;
    }
    const branchPolicy = current.deployment_branch_policy;
    const validBranchPolicy = branchPolicy &&
      typeof branchPolicy.protected_branches === 'boolean' &&
      typeof branchPolicy.custom_branch_policies === 'boolean';
    if (!validBranchPolicy) {
      errors.push(`${repository} has missing or malformed ${environmentName} deployment branch policy metadata.`);
    } else if (branchPolicy.protected_branches || !branchPolicy.custom_branch_policies) {
      errors.push(`${repository} does not use an exact custom ${environmentName} deployment branch policy.`);
    } else {
      const policyPayload = parseJson(
        execute(apiArguments(`repos/${repository}/environments/${environmentName}/deployment-branch-policies?per_page=100`)),
        `${repository} deployment policies`,
      );
      policies = collection(policyPayload, 'branch_policies', `${repository} deployment policies`);
      const expected = policies.filter((policy) => policy.name === releaseBranch && policy.type === 'branch');
      const unexpected = policies.filter((policy) => policy.name !== releaseBranch || policy.type !== 'branch');
      if (unexpected.length > 0) errors.push(`${repository} has unexpected ${environmentName} deployment branch policies.`);
      if (expected.length > 1) errors.push(`${repository} has duplicate ${environmentName} release branch policies.`);
    }
    const secretPayload = parseJson(
      execute(apiArguments(`repos/${repository}/environments/${environmentName}/secrets?per_page=100`)),
      `${repository} environment secrets`,
    );
    configuredSecrets = collection(secretPayload, 'secrets', `${repository} environment secrets`).map((secret) => secret.name);
    const unexpectedSecrets = configuredSecrets.filter((name) => !secretNames.includes(name));
    if (unexpectedSecrets.length > 0) errors.push(`${repository} has unexpected ${environmentName} secrets.`);
  }

  const desired = current && validProtectionMetadata
    ? protectedEnvironment(reviewerId, current)
    : null;
  if (desired?.reviewers.length > 6) {
    errors.push(`${repository} cannot add JJJ without exceeding GitHub's six-reviewer limit.`);
  }
  if (desired && JSON.stringify(currentEnvironmentConfiguration(current)) !== JSON.stringify(desired)) {
    errors.push(`${repository} must have its required JJJ reviewer configured before credential provisioning.`);
  }

  return {
    repository,
    environment: environmentName,
    release_branch: releaseBranch,
    current,
    policies,
    configured_secrets: configuredSecrets,
    desired,
    errors,
  };
}

export function applyReleaseEnvironment({ inspection, username, password, execute = runGitHub }) {
  if (!username || !password) throw new Error('Both WordPress.org credentials are required.');
  if (inspection.errors.length > 0 || !inspection.current || !inspection.desired) {
    throw new Error(`${inspection.repository} did not pass the read-only release-environment inspection.`);
  }
  const repository = inspection.repository;
  const endpoint = `repos/${repository}/environments/${environmentName}`;

  const hasExpectedPolicy = inspection.policies.some(
    (policy) => policy.name === inspection.release_branch && policy.type === 'branch',
  );
  if (!hasExpectedPolicy) {
    execute(
      apiArguments(`${endpoint}/deployment-branch-policies`, 'POST', true),
      `${JSON.stringify({ name: inspection.release_branch })}\n`,
    );
  }

  execute(['secret', 'set', secretNames[0], '--repo', repository, '--env', environmentName], username);
  execute(['secret', 'set', secretNames[1], '--repo', repository, '--env', environmentName], password);
  return { repository, environment: environmentName, release_branch: inspection.release_branch };
}

export function provisionFleet({ targets, reviewerId, username, password, apply = false, execute = runGitHub }) {
  const inspections = [];
  let inspectionFailure = null;
  for (const target of targets) {
    try {
      inspections.push(inspectReleaseEnvironment({ target, reviewerId, execute }));
    } catch (error) {
      const reason = redactCredentials(error.message, process.env, [username, password]);
      inspections.push({ repository: target.repository, environment: environmentName, errors: [reason] });
      inspectionFailure ||= { repository: target.repository, reason };
    }
  }
  const report = { mode: apply ? 'apply' : 'audit', inspected: inspections, applied: [], failed: null, pending: [] };
  if (inspectionFailure) {
    report.failed = inspectionFailure;
    if (apply) report.pending = targets.map((target) => target.repository);
    return report;
  }
  const unsafeInspection = inspections.find((inspection) => inspection.errors.length > 0);
  if (unsafeInspection) {
    report.failed = {
      repository: unsafeInspection.repository,
      reason: `Read-only ${apply ? 'preflight' : 'audit'} found unsafe configuration; no changes were made.`,
    };
    if (apply) report.pending = inspections.map((inspection) => inspection.repository);
    return report;
  }
  if (!apply) return report;

  for (const inspection of inspections) {
    try {
      const target = targets.find((candidate) => candidate.repository === inspection.repository);
      const fresh = inspectReleaseEnvironment({ target, reviewerId, execute });
      if (fresh.errors.length > 0) throw new Error(`Pre-write reinspection failed for ${inspection.repository}.`);
      applyReleaseEnvironment({ inspection: fresh, username, password, execute });
      const verified = inspectReleaseEnvironment({
        target,
        reviewerId,
        execute,
      });
      const missingSecrets = secretNames.filter((name) => !verified.configured_secrets.includes(name));
      const reviewerRule = verified.current?.protection_rules?.find((rule) => rule.type === 'required_reviewers');
      const hasReviewer = reviewerRule?.reviewers?.some(
        ({ type, reviewer }) => type === 'User' && reviewer.id === reviewerId,
      );
      const hasPolicy = verified.policies.some(
        (policy) => policy.name === inspection.release_branch && policy.type === 'branch',
      );
      if (
        verified.errors.length > 0 ||
        missingSecrets.length > 0 ||
        !hasReviewer ||
        !verified.current?.deployment_branch_policy?.custom_branch_policies ||
        !hasPolicy ||
        JSON.stringify(currentEnvironmentConfiguration(verified.current)) !== JSON.stringify(fresh.desired)
      ) {
        throw new Error(`Post-write verification failed for ${inspection.repository}.`);
      }
      report.applied.push({
        repository: inspection.repository,
        environment: environmentName,
        release_branch: inspection.release_branch,
        secrets: secretNames,
      });
    } catch (error) {
      report.failed = {
        repository: inspection.repository,
        reason: redactCredentials(error.message, process.env, [username, password]),
      };
      const failedIndex = inspections.findIndex((candidate) => candidate.repository === inspection.repository);
      report.pending = inspections.slice(failedIndex + 1).map((candidate) => candidate.repository);
      break;
    }
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { mode, requested } = commandArguments(process.argv.slice(2));
    const username = process.env.WORDPRESS_ORG_USERNAME;
    const password = process.env.WORDPRESS_ORG_PASSWORD;
    if (mode === 'apply' && (!username || !password)) {
      throw new Error('Apply mode requires WORDPRESS_ORG_USERNAME and WORDPRESS_ORG_PASSWORD from a secure provider.');
    }

    const reviewer = parseJson(runGitHub(apiArguments(`users/${reviewerLogin}`)), 'Release reviewer');
    const reviewerId = releaseReviewerId(reviewer);
    const inventory = loadInventory(resolve(repositoryRoot, 'portfolio/plugins.json'));
    const targets = selectReleaseTargets(inventory, requested);
    const report = provisionFleet({ targets, reviewerId, username, password, apply: mode === 'apply' });
    process.stdout.write(`${JSON.stringify(report, (key, value) => key === 'current' ? undefined : value, 2)}\n`);
    if (report.failed) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${redactCredentials(error.message)}\n`);
    process.exitCode = 2;
  }
}
