#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInventory } from './sync-plugin-standards.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const organization = 'stuttter';
const environmentName = 'wordpress.org';
const reviewerLogin = 'JJJ';
const secretNames = ['WORDPRESS_ORG_USERNAME', 'WORDPRESS_ORG_PASSWORD'];
const reusableWorkflowSecretNames = ['STUTTTER_WORDPRESS_ORG_USERNAME', 'STUTTTER_WORDPRESS_ORG_PASSWORD'];
const apiHeaders = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10'];
export const provisionUsage = `Usage:
  npm run release:provision -- audit [all|owner/repository]
  npm run release:provision -- apply all

GitHub CLI authentication must be pinned to github.com and authorized to read
repository and environment secrets and to manage Stuttter organization Actions
secrets. A classic token needs repo and admin:org scopes.
`;

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
  if (argumentsList.length === 1 && ['--help', '-h'].includes(argumentsList[0])) {
    return { help: true, mode: 'audit', requested: 'all' };
  }
  if (argumentsList.length > 2) {
    throw new Error('Expected at most one mode and one repository target.');
  }
  const [mode = 'audit', requested = 'all'] = argumentsList;
  if (!['audit', 'apply'].includes(mode)) throw new Error('Mode must be audit or apply.');
  if (mode === 'apply' && requested !== 'all') {
    throw new Error(`${mode} mode must reconcile the complete approved release repository allowlist.`);
  }
  return { help: false, mode, requested };
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
  let environmentSecrets = [];
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
    environmentSecrets = collection(secretPayload, 'secrets', `${repository} environment secrets`).map((secret) => secret.name);
    const conflictingAliases = environmentSecrets.filter((name) => reusableWorkflowSecretNames.includes(name));
    if (conflictingAliases.length > 0) {
      errors.push(`${repository} has ${environmentName} secrets that shadow the reusable-workflow credential inputs.`);
    }
    const unexpectedSecrets = environmentSecrets.filter((name) =>
      !secretNames.includes(name) && !reusableWorkflowSecretNames.includes(name)
    );
    if (unexpectedSecrets.length > 0) errors.push(`${repository} has unexpected ${environmentName} secrets.`);
  }

  const repositorySecretPayload = parseJson(
    execute(apiArguments(`repos/${repository}/actions/secrets?per_page=100`)),
    `${repository} repository secrets`,
  );
  const repositorySecrets = collection(
    repositorySecretPayload,
    'secrets',
    `${repository} repository secrets`,
  ).map((secret) => secret.name);
  const credentialCopies = {
    repository: repositorySecrets.filter((name) => secretNames.includes(name)),
    environment: environmentSecrets.filter((name) => secretNames.includes(name)),
  };
  if (credentialCopies.repository.length > 0) {
    errors.push(`${repository} has repository credential copies that shadow the organization secrets.`);
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
    environment_secrets: environmentSecrets,
    repository_secrets: repositorySecrets,
    credential_copies: credentialCopies,
    desired,
    errors,
  };
}

export function applyReleaseEnvironment({ inspection, execute = runGitHub }) {
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

  return {
    repository,
    environment: environmentName,
    release_branch: inspection.release_branch,
    changed: hasExpectedPolicy ? [] : ['deployment_branch_policy'],
  };
}

export function inspectOrganizationCredentials({ approvedRepositories, execute = runGitHub }) {
  const expectedRepositories = [...approvedRepositories].sort();
  const payload = parseJson(
    execute(apiArguments(`orgs/${organization}/actions/secrets?per_page=100`)),
    `${organization} organization secrets`,
  );
  const available = collection(payload, 'secrets', `${organization} organization secrets`);
  const secrets = [];
  const errors = [];
  for (const name of secretNames) {
    const metadata = available.find((secret) => secret.name === name) || null;
    let selectedRepositories = [];
    if (metadata?.visibility === 'selected') {
      const selectedPayload = parseJson(
        execute(apiArguments(`orgs/${organization}/actions/secrets/${name}/repositories?per_page=100`)),
        `${name} selected repositories`,
      );
      selectedRepositories = collection(
        selectedPayload,
        'repositories',
        `${name} selected repositories`,
      ).map((repository) => repository.full_name).sort();
    }
    if (!metadata) {
      errors.push(`${organization} is missing the ${name} organization secret.`);
    } else if (metadata.visibility !== 'selected') {
      errors.push(`${name} does not use selected-repository visibility.`);
    } else if (JSON.stringify(selectedRepositories) !== JSON.stringify(expectedRepositories)) {
      errors.push(`${name} is not scoped to the exact approved release repositories.`);
    }
    secrets.push({
      name,
      visibility: metadata?.visibility || null,
      updated_at: metadata?.updated_at || null,
      selected_repositories: selectedRepositories,
    });
  }
  return { organization, expected_repositories: expectedRepositories, secrets, errors };
}

export function applyOrganizationCredentials({ approvedRepositories, username, password, execute = runGitHub, onChange = () => {} }) {
  if (!username || !password) throw new Error('Both WordPress.org credentials are required.');
  const sortedRepositories = [...approvedRepositories].sort();
  if (sortedRepositories.some((repository) => !repository.startsWith(`${organization}/`))) {
    throw new Error('The organization secret allowlist must contain only Stuttter repositories.');
  }
  const repositoryNames = sortedRepositories
    .map((repository) => repository.slice(`${organization}/`.length));
  if (repositoryNames.length === 0 || repositoryNames.some((repository) => !repository)) {
    throw new Error('The organization secret allowlist must contain approved Stuttter repositories.');
  }
  const repositoryList = repositoryNames.join(',');
  execute(['secret', 'set', secretNames[0], '--org', organization, '--repos', repositoryList], username);
  onChange({ scope: 'organization', name: secretNames[0], action: 'set' });
  execute(['secret', 'set', secretNames[1], '--org', organization, '--repos', repositoryList], password);
  onChange({ scope: 'organization', name: secretNames[1], action: 'set' });
}

function hasCredentialCopies(inspection) {
  return inspection.credential_copies.repository.length > 0 || inspection.credential_copies.environment.length > 0;
}

export function provisionFleet({
  targets,
  approvedRepositories = targets.map((target) => target.repository),
  reviewerId,
  username,
  password,
  apply = false,
  execute = runGitHub,
}) {
  const targetRepositories = targets.map((target) => target.repository).sort();
  const expectedRepositories = [...approvedRepositories].sort();
  if (apply && JSON.stringify(targetRepositories) !== JSON.stringify(expectedRepositories)) {
    return {
      mode: 'apply',
      organization_credentials: null,
      inspected: [],
      prepared: [],
      changed: [],
      cleanup_required: [],
      applied: [],
      failed: { organization, reason: 'Apply requires the complete approved release repository allowlist.' },
      pending: expectedRepositories,
    };
  }
  if (apply && (!username || !password)) {
    return {
      mode: 'apply',
      organization_credentials: null,
      inspected: [],
      prepared: [],
      changed: [],
      cleanup_required: [],
      applied: [],
      failed: { organization, reason: 'Apply requires both WordPress.org credentials before any write phase.' },
      pending: expectedRepositories,
    };
  }
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
  let organizationCredentials = null;
  try {
    organizationCredentials = inspectOrganizationCredentials({ approvedRepositories, execute });
  } catch (error) {
    const reason = redactCredentials(error.message, process.env, [username, password]);
    inspectionFailure ||= { organization, reason };
  }
  const report = {
    mode: apply ? 'apply' : 'audit',
    organization_credentials: organizationCredentials,
    inspected: inspections,
    prepared: [],
    changed: [],
    cleanup_required: inspections.filter(hasCredentialCopies).map((inspection) => ({
      repository: inspection.repository,
      credential_copies: inspection.credential_copies,
    })),
    applied: [],
    failed: null,
    pending: [],
  };
  if (inspectionFailure) {
    report.failed = inspectionFailure;
    if (apply) report.pending = targets.map((target) => target.repository);
    return report;
  }
  const unsafeInspection = inspections.find((inspection) => inspection.errors.length > 0);
  const organizationDrift = organizationCredentials.errors.length > 0;
  if (unsafeInspection || (!apply && organizationDrift)) {
    const subject = unsafeInspection?.repository || organization;
    report.failed = {
      repository: subject,
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
      const preparation = applyReleaseEnvironment({ inspection: fresh, execute });
      for (const change of preparation.changed) {
        report.changed.push({ scope: 'environment', repository: inspection.repository, change });
      }
      const verified = inspectReleaseEnvironment({
        target,
        reviewerId,
        execute,
      });
      const reviewerRule = verified.current?.protection_rules?.find((rule) => rule.type === 'required_reviewers');
      const hasReviewer = reviewerRule?.reviewers?.some(
        ({ type, reviewer }) => type === 'User' && reviewer.id === reviewerId,
      );
      const hasPolicy = verified.policies.some(
        (policy) => policy.name === inspection.release_branch && policy.type === 'branch',
      );
      if (
        verified.errors.length > 0 ||
        !hasReviewer ||
        !verified.current?.deployment_branch_policy?.custom_branch_policies ||
        !hasPolicy ||
        JSON.stringify(currentEnvironmentConfiguration(verified.current)) !== JSON.stringify(fresh.desired)
      ) {
        throw new Error(`Release-environment verification failed for ${inspection.repository}.`);
      }
      report.prepared.push({
        repository: inspection.repository,
        environment: environmentName,
        release_branch: inspection.release_branch,
        changed: preparation.changed,
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
  if (report.failed) return report;

  try {
    applyOrganizationCredentials({
      approvedRepositories,
      username,
      password,
      execute,
      onChange: (change) => report.changed.push(change),
    });
    const verifiedOrganization = inspectOrganizationCredentials({ approvedRepositories, execute });
    if (verifiedOrganization.errors.length > 0) {
      throw new Error('Post-write verification failed for the organization credentials.');
    }
    report.organization_credentials = verifiedOrganization;
  } catch (error) {
    report.failed = {
      organization,
      reason: redactCredentials(error.message, process.env, [username, password]),
    };
    report.pending = inspections.map((inspection) => inspection.repository);
    return report;
  }

  report.applied = report.prepared.map((preparation) => ({
    ...preparation,
    organization_secrets: secretNames,
    credential_copies_preserved: inspections.find(
      (inspection) => inspection.repository === preparation.repository,
    ).credential_copies,
  }));
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { help, mode, requested } = commandArguments(process.argv.slice(2));
    if (help) {
      process.stdout.write(provisionUsage);
      process.exit(0);
    }
    const username = process.env.WORDPRESS_ORG_USERNAME;
    const password = process.env.WORDPRESS_ORG_PASSWORD;
    if (mode === 'apply' && (!username || !password)) {
      throw new Error('Apply mode requires WORDPRESS_ORG_USERNAME and WORDPRESS_ORG_PASSWORD from a secure provider.');
    }

    const reviewer = parseJson(runGitHub(apiArguments(`users/${reviewerLogin}`)), 'Release reviewer');
    const reviewerId = releaseReviewerId(reviewer);
    const inventory = loadInventory(resolve(repositoryRoot, 'portfolio/plugins.json'));
    const approvedTargets = selectReleaseTargets(inventory);
    const targets = selectReleaseTargets(inventory, requested);
    const report = provisionFleet({
      targets,
      approvedRepositories: approvedTargets.map((target) => target.repository),
      reviewerId,
      username,
      password,
      apply: mode === 'apply',
    });
    process.stdout.write(`${JSON.stringify(report, (key, value) => key === 'current' ? undefined : value, 2)}\n`);
    if (report.failed) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${redactCredentials(error.message)}\n`);
    process.exitCode = 2;
  }
}
