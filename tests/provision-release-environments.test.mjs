import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReleaseEnvironment,
  applyOrganizationCredentials,
  commandArguments,
  currentEnvironmentConfiguration,
  githubChildEnvironment,
  githubFailure,
  inspectReleaseEnvironment,
  inspectOrganizationCredentials,
  protectedEnvironment,
  provisionFleet,
  provisionUsage,
  redactCredentials,
  releaseReviewerId,
  runGitHub,
  selectReleaseTargets,
} from '../scripts/provision-release-environments.mjs';

const target = {
  repository: 'stuttter/example-plugin',
  enabled: true,
  managed_paths: ['ci', 'release'],
  manifest: { wordpress_org: true, release_branch: 'master' },
};

function currentEnvironment(overrides = {}) {
  return {
    name: 'wordpress.org',
    can_admins_bypass: false,
    protection_rules: [{
      type: 'required_reviewers',
      prevent_self_review: false,
      reviewers: [{ type: 'User', reviewer: { id: 88951, login: 'JJJ' } }],
    }, { type: 'branch_policy' }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    ...overrides,
  };
}

function organizationResponse(args, repositories = [target.repository], names = ['WORDPRESS_ORG_USERNAME', 'WORDPRESS_ORG_PASSWORD']) {
  const endpoint = args.find((argument) => argument.startsWith('orgs/')) || '';
  if (endpoint === 'orgs/stuttter/actions/secrets?per_page=100') {
    return JSON.stringify({ total_count: names.length, secrets: names.map((name) => ({ name, visibility: 'selected' })) });
  }
  if (endpoint.includes('/repositories?')) {
    return JSON.stringify({
      total_count: repositories.length,
      repositories: repositories.map((full_name) => ({ full_name })),
    });
  }
  return null;
}

function readExecutor({
  environment = currentEnvironment(),
  policies = [{ name: 'master', type: 'branch' }],
  environmentSecrets = [],
  repositorySecrets = [],
  organizationRepositories = [target.repository],
  organizationSecrets = ['WORDPRESS_ORG_USERNAME', 'WORDPRESS_ORG_PASSWORD'],
} = {}) {
  const calls = [];
  const execute = (args, input) => {
    calls.push({ args, input });
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint === 'repos/stuttter/example-plugin') {
      return JSON.stringify({ full_name: target.repository, owner: { login: 'stuttter' }, fork: false, archived: false, default_branch: 'master' });
    }
    if (endpoint.includes('/environments?')) return JSON.stringify({ total_count: 1, environments: [environment] });
    if (endpoint.includes('/deployment-branch-policies?')) return JSON.stringify({ total_count: policies.length, branch_policies: policies });
    if (endpoint.includes(`/environments/wordpress.org/secrets?`)) return JSON.stringify({ total_count: environmentSecrets.length, secrets: environmentSecrets.map((name) => ({ name })) });
    if (endpoint.includes('/actions/secrets?')) return JSON.stringify({ total_count: repositorySecrets.length, secrets: repositorySecrets.map((name) => ({ name })) });
    const organizationOutput = organizationResponse(args, organizationRepositories, organizationSecrets);
    if (organizationOutput !== null) return organizationOutput;
    return '{}';
  };
  return { calls, execute };
}

test('only enabled managed WordPress.org release targets are selected', () => {
  const inventory = { repositories: [
    target,
    { ...target, repository: 'stuttter/disabled', enabled: false },
    { ...target, repository: 'stuttter/github-only', manifest: { wordpress_org: false } },
    { ...target, repository: 'stuttter/unmanaged', managed_paths: ['ci'] },
  ] };
  assert.deepEqual(selectReleaseTargets(inventory), [target]);
  assert.throws(() => selectReleaseTargets(inventory, 'stuttter/disabled'), /not an enabled WordPress\.org release target/);
});

test('the release reviewer identity is fixed to JJJ', () => {
  assert.equal(releaseReviewerId({ login: 'JJJ', id: 88951 }), 88951);
  assert.throws(() => releaseReviewerId({ login: 'someone-else', id: 42 }), /fixed JJJ release reviewer/);
});

test('command arguments reject extra credential-writing scope', () => {
  assert.deepEqual(commandArguments([]), { help: false, mode: 'audit', requested: 'all' });
  assert.throws(() => commandArguments(['apply', 'stuttter/example-plugin']), /complete approved release repository allowlist/);
  assert.deepEqual(commandArguments(['--help']), { help: true, mode: 'audit', requested: 'all' });
  assert.match(provisionUsage, /admin:org/);
  assert.throws(() => commandArguments(['apply', 'all', 'unexpected-target']), /at most one mode and one repository target/);
});

test('the desired environment preserves stronger existing protections', () => {
  const current = currentEnvironment({ protection_rules: [{
    type: 'required_reviewers',
    prevent_self_review: true,
    reviewers: [{ type: 'Team', reviewer: { id: 42 } }],
  }, { type: 'wait_timer', wait_timer: 15 }, { type: 'branch_policy' }] });
  const desired = {
    wait_timer: 15,
    prevent_self_review: true,
    reviewers: [{ type: 'Team', id: 42 }, { type: 'User', id: 88951 }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  assert.deepEqual(protectedEnvironment(88951, current), desired);
  assert.deepEqual(currentEnvironmentConfiguration(currentEnvironment({
    protection_rules: [{
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{ type: 'Team', reviewer: { id: 42 } }, { type: 'User', reviewer: { id: 88951 } }],
    }, { type: 'wait_timer', wait_timer: 15 }, { type: 'branch_policy' }],
  })), desired);
});

test('environment comparison ignores reviewer ordering', () => {
  const first = currentEnvironment({ protection_rules: [{
    type: 'required_reviewers',
    prevent_self_review: true,
    reviewers: [{ type: 'User', reviewer: { id: 88951 } }, { type: 'Team', reviewer: { id: 42 } }],
  }, { type: 'branch_policy' }] });
  const second = currentEnvironment({
    protection_rules: [{
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{ type: 'Team', reviewer: { id: 42 } }, { type: 'User', reviewer: { id: 88951 } }],
    }, { type: 'branch_policy' }],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
  });
  assert.deepEqual(currentEnvironmentConfiguration(first), currentEnvironmentConfiguration(second));
});

test('credentials are stripped from child environments and redacted from errors', () => {
  const environment = { GH_TOKEN: 'token', GH_HOST: 'enterprise.example', CREDENTIAL_ALIAS: 'prefix/application-password/suffix', WORDPRESS_ORG_USERNAME: 'release-user', WORDPRESS_ORG_PASSWORD: 'application-password' };
  assert.deepEqual(githubChildEnvironment(environment), { GH_TOKEN: 'token', GH_HOST: 'github.com' });
  assert.throws(
    () => githubChildEnvironment({ WORDPRESS_ORG_USERNAME: 'release-user', WORDPRESS_ORG_PASSWORD: 'github.com' }),
    /conflicts with the required GitHub host/,
  );
  assert.throws(
    () => githubChildEnvironment({ WORDPRESS_ORG_USERNAME: 'release-user', WORDPRESS_ORG_PASSWORD: 'github' }),
    /conflicts with the required GitHub host/,
  );
  assert.equal(redactCredentials('release-user:application-password', environment), '[REDACTED]:[REDACTED]');
  assert.equal(githubFailure({ status: null, stderr: undefined, error: new Error('could not spawn') }, ['api'], environment), 'could not spawn');
});

test('GitHub subprocess receives stdin and a sanitized, pinned environment', () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const environment = {
    GH_TOKEN: 'github-token',
    GH_HOST: 'enterprise.example',
    CREDENTIAL_ALIAS: 'prefix/application-password/suffix',
    WORDPRESS_ORG_USERNAME: 'release-user',
    WORDPRESS_ORG_PASSWORD: 'application-password',
  };
  assert.equal(runGitHub(['secret', 'set', 'WORDPRESS_ORG_PASSWORD'], 'application-password', runner, environment), 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args, ['secret', 'set', 'WORDPRESS_ORG_PASSWORD']);
  assert.equal(calls[0].options.input, 'application-password');
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(calls[0].options.env, { GH_TOKEN: 'github-token', GH_HOST: 'github.com' });
});

test('GitHub subprocess failures redact credentials from an explicit environment', () => {
  const runner = () => ({ status: 1, stdout: '', stderr: 'failed with application-password' });
  const environment = {
    WORDPRESS_ORG_USERNAME: 'release-user',
    WORDPRESS_ORG_PASSWORD: 'application-password',
  };
  assert.throws(
    () => runGitHub(['secret', 'set', 'WORDPRESS_ORG_PASSWORD'], 'application-password', runner, environment),
    /failed with \[REDACTED\]/,
  );
});

test('credential redaction replaces longer overlapping values first', () => {
  const environment = { WORDPRESS_ORG_USERNAME: 'release-user', WORDPRESS_ORG_PASSWORD: 'release-user-secret' };
  assert.equal(redactCredentials('release-user-secret belongs to release-user', environment), '[REDACTED] belongs to [REDACTED]');
});

test('inspection requires explicit non-fork and non-archived metadata', () => {
  for (const missingField of ['fork', 'archived']) {
    const base = readExecutor();
    const execute = (args, input) => {
      const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
      if (endpoint === 'repos/stuttter/example-plugin') {
        const metadata = { full_name: target.repository, owner: { login: 'stuttter' }, fork: false, archived: false, default_branch: 'master' };
        delete metadata[missingField];
        return JSON.stringify(metadata);
      }
      return base.execute(args, input);
    };
    assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute }).errors.join(' '), /not an active, owned Stuttter repository/);
  }
});

test('inspection rejects malformed reviewer metadata and a missing required JJJ reviewer', () => {
  const malformed = readExecutor({ environment: currentEnvironment({ protection_rules: [{
    type: 'required_reviewers',
    prevent_self_review: false,
    reviewers: [{ type: 'User', reviewer: {} }],
  }, { type: 'branch_policy' }] }) });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: malformed.execute }).errors.join(' '), /malformed wordpress\.org reviewer metadata/i);

  const missing = readExecutor({ environment: currentEnvironment({ protection_rules: [{
    type: 'required_reviewers',
    prevent_self_review: false,
    reviewers: [{ type: 'Team', reviewer: { id: 42 } }],
  }, { type: 'branch_policy' }] }) });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: missing.execute }).errors.join(' '), /required JJJ reviewer configured/);
});

test('inspection rejects malformed self-review, wait-timer, and duplicate protection rules', () => {
  const malformedSelfReview = readExecutor({ environment: currentEnvironment({ protection_rules: [{
    type: 'required_reviewers',
    prevent_self_review: 'true',
    reviewers: [{ type: 'User', reviewer: { id: 88951 } }],
  }, { type: 'branch_policy' }] }) });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: malformedSelfReview.execute }).errors.join(' '), /malformed wordpress\.org reviewer metadata/i);

  for (const waitTimer of [-1, 43201, '15']) {
    const malformedWait = readExecutor({ environment: currentEnvironment({ protection_rules: [{
      type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { id: 88951 } }],
    }, { type: 'wait_timer', wait_timer: waitTimer }, { type: 'branch_policy' }] }) });
    assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: malformedWait.execute }).errors.join(' '), /malformed wordpress\.org wait-timer metadata/i);
  }

  const duplicate = readExecutor({ environment: currentEnvironment({ protection_rules: [{
    type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { id: 88951 } }],
  }, { type: 'branch_policy' }, { type: 'branch_policy' }] }) });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: duplicate.execute }).errors.join(' '), /duplicate wordpress\.org branch_policy protection rules/i);
});

test('inspection is read-only and rejects policy drift before any mutation', () => {
  const { calls, execute } = readExecutor({ policies: [{ name: 'feature/*', type: 'branch' }] });
  const inspection = inspectReleaseEnvironment({ target, reviewerId: 88951, execute });
  assert.match(inspection.errors.join(' '), /unexpected wordpress\.org deployment branch policies/i);
  assert.equal(calls.some((call) => call.args.includes('PUT') || call.args.includes('POST') || call.args[0] === 'secret'), false);
  assert.equal(calls.every((call) => call.args.includes('X-GitHub-Api-Version: 2026-03-10')), true);
  assert.equal(calls.filter((call) => call.args.some((argument) => argument.includes('?per_page=100'))).length, 4);
});

test('inspection rejects administrator bypass and incomplete pagination', () => {
  const bypass = readExecutor({ environment: currentEnvironment({ can_admins_bypass: true }) });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: bypass.execute }).errors.join(' '), /permits administrators to bypass/);

  const incomplete = readExecutor();
  const execute = (args, input) => {
    const output = incomplete.execute(args, input);
    if (args.some((argument) => argument.includes('/environments?'))) return JSON.stringify({ total_count: 2, environments: [currentEnvironment()] });
    return output;
  };
  assert.throws(() => inspectReleaseEnvironment({ target, reviewerId: 88951, execute }), /incomplete or malformed/);
});

test('inspection rejects missing, malformed, and non-exact deployment branch policy metadata', () => {
  for (const deploymentBranchPolicy of [
    null,
    {},
    { protected_branches: false },
    { protected_branches: true, custom_branch_policies: false },
  ]) {
    const candidate = readExecutor({ environment: currentEnvironment({ deployment_branch_policy: deploymentBranchPolicy }) });
    assert.match(
      inspectReleaseEnvironment({ target, reviewerId: 88951, execute: candidate.execute }).errors.join(' '),
      /deployment branch policy|exact custom/i,
    );
    assert.equal(candidate.calls.some((call) => call.args.includes('PUT') || call.args[0] === 'secret'), false);
  }
});

test('inspection rejects duplicate policies, unrelated environment secrets, and callee aliases', () => {
  const duplicate = readExecutor({ policies: [{ name: 'master', type: 'branch' }, { name: 'master', type: 'branch' }] });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: duplicate.execute }).errors.join(' '), /duplicate wordpress\.org release branch policies/i);
  const extraSecret = readExecutor({ environmentSecrets: ['WORDPRESS_ORG_USERNAME', 'UNRELATED_SECRET'] });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: extraSecret.execute }).errors.join(' '), /unexpected wordpress\.org secrets/i);
  const shadowingAlias = readExecutor({ environmentSecrets: ['STUTTTER_WORDPRESS_ORG_PASSWORD'] });
  assert.match(
    inspectReleaseEnvironment({ target, reviewerId: 88951, execute: shadowingAlias.execute }).errors.join(' '),
    /shadow the reusable-workflow credential inputs/i,
  );
});

test('inspection rejects a seventh required reviewer before mutation', () => {
  const reviewers = Array.from({ length: 6 }, (_value, index) => ({ type: 'Team', reviewer: { id: index + 1 } }));
  const full = readExecutor({ environment: currentEnvironment({
    protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers }, { type: 'branch_policy' }],
  }) });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: full.execute }).errors.join(' '), /six-reviewer limit/);
  assert.equal(full.calls.some((call) => call.args.includes('PUT') || call.args[0] === 'secret'), false);
});

test('inspection reports environment copies and rejects repository copies', () => {
  const duplicate = readExecutor({
    environmentSecrets: ['WORDPRESS_ORG_PASSWORD'],
    repositorySecrets: ['WORDPRESS_ORG_USERNAME', 'UNRELATED_SECRET'],
  });
  const inspection = inspectReleaseEnvironment({ target, reviewerId: 88951, execute: duplicate.execute });
  assert.deepEqual(inspection.credential_copies, {
    repository: ['WORDPRESS_ORG_USERNAME'],
    environment: ['WORDPRESS_ORG_PASSWORD'],
  });
  assert.match(inspection.errors.join(' '), /repository credential copies that shadow the organization secrets/i);
});

test('organization credential audit requires both secrets and the exact repository allowlist', () => {
  const exact = readExecutor();
  assert.deepEqual(inspectOrganizationCredentials({ approvedRepositories: [target.repository], execute: exact.execute }).errors, []);

  const missing = readExecutor({ organizationSecrets: ['WORDPRESS_ORG_USERNAME'] });
  assert.match(inspectOrganizationCredentials({ approvedRepositories: [target.repository], execute: missing.execute }).errors.join(' '), /missing the WORDPRESS_ORG_PASSWORD/);

  const broad = readExecutor({ organizationRepositories: [target.repository, 'stuttter/unapproved'] });
  assert.match(inspectOrganizationCredentials({ approvedRepositories: [target.repository], execute: broad.execute }).errors.join(' '), /exact approved release repositories/);

  const approved = ['stuttter/wp-chosen', 'stuttter/wp-reset-filters'];
  const fleet = readExecutor({ organizationRepositories: [...approved].reverse() });
  const fleetInspection = inspectOrganizationCredentials({ approvedRepositories: approved, execute: fleet.execute });
  assert.deepEqual(fleetInspection.expected_repositories, approved);
  assert.deepEqual(fleetInspection.errors, []);
});

test('organization credential apply uses stdin and an exact selected-repository allowlist', () => {
  const calls = [];
  const execute = (args, input) => calls.push({ args, input });
  applyOrganizationCredentials({
    approvedRepositories: ['stuttter/second-plugin', target.repository],
    username: 'release-user',
    password: 'application-password',
    execute,
  });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['secret', 'set', 'WORDPRESS_ORG_USERNAME', '--org', 'stuttter', '--repos', 'example-plugin,second-plugin'],
    ['secret', 'set', 'WORDPRESS_ORG_PASSWORD', '--org', 'stuttter', '--repos', 'example-plugin,second-plugin'],
  ]);
  assert.deepEqual(calls.map(({ input }) => input), ['release-user', 'application-password']);
  assert.equal(calls.some(({ args }) => args.includes('release-user') || args.includes('application-password')), false);
});

test('release-environment apply only creates a missing exact branch policy', () => {
  const { calls, execute } = readExecutor({ policies: [] });
  const inspection = inspectReleaseEnvironment({ target, reviewerId: 88951, execute });
  applyReleaseEnvironment({ inspection, execute });
  const writes = calls.filter((call) => call.args.includes('POST') || call.args.includes('PUT') || call.args[0] === 'secret');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].input), { name: 'master' });
});

test('fleet audit reports and permits a canonical environment credential copy', () => {
  const duplicate = readExecutor({ environmentSecrets: ['WORDPRESS_ORG_PASSWORD'] });
  const report = provisionFleet({ targets: [target], reviewerId: 88951, apply: false, execute: duplicate.execute });
  assert.equal(report.failed, null);
  assert.deepEqual(report.cleanup_required, [{
    repository: target.repository,
    credential_copies: { repository: [], environment: ['WORDPRESS_ORG_PASSWORD'] },
  }]);
  assert.equal(duplicate.calls.some((call) => call.args.includes('DELETE') || call.args[0] === 'secret'), false);
});

test('fleet rejects repository credential copies and environment aliases before mutation', () => {
  for (const apply of [false, true]) {
    for (const candidate of [
      readExecutor({ repositorySecrets: ['WORDPRESS_ORG_USERNAME'] }),
      readExecutor({ environmentSecrets: ['STUTTTER_WORDPRESS_ORG_USERNAME'] }),
    ]) {
      const report = provisionFleet({
        targets: [target],
        reviewerId: 88951,
        username: apply ? 'release-user' : undefined,
        password: apply ? 'release-password' : undefined,
        apply,
        execute: candidate.execute,
      });
      assert.equal(report.failed.repository, target.repository);
      assert.match(report.failed.reason, new RegExp(`${apply ? 'preflight' : 'audit'} found unsafe configuration`));
      assert.equal(candidate.calls.some(
        (call) => call.args.includes('POST') || call.args.includes('DELETE') || call.args[0] === 'secret'
      ), false);
    }
  }
});

test('fleet apply rejects a partial allowlist before reading or writing', () => {
  const { calls, execute } = readExecutor();
  const report = provisionFleet({
    targets: [target],
    approvedRepositories: [target.repository, 'stuttter/second-plugin'],
    reviewerId: 88951,
    username: 'release-user',
    password: 'release-password',
    apply: true,
    execute,
  });
  assert.match(report.failed.reason, /complete approved release repository allowlist/);
  assert.equal(calls.length, 0);
});

test('fleet apply rejects missing credentials before reading or writing', () => {
  const { calls, execute } = readExecutor();
  const report = provisionFleet({ targets: [target], reviewerId: 88951, apply: true, execute });
  assert.match(report.failed.reason, /requires both WordPress\.org credentials/);
  assert.equal(calls.length, 0);
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.prepared, []);
});

test('fleet apply makes no changes when a release environment fails preflight', () => {
  const invalid = readExecutor({ environment: currentEnvironment({ can_admins_bypass: true }) });
  const report = provisionFleet({
    targets: [target],
    reviewerId: 88951,
    username: 'release-user',
    password: 'release-password',
    apply: true,
    execute: invalid.execute,
  });
  assert.equal(report.applied.length, 0);
  assert.match(report.failed.reason, /no changes were made/);
  assert.equal(invalid.calls.some((call) => call.args.includes('POST') || call.args.includes('DELETE') || call.args[0] === 'secret'), false);
});

test('fleet verifies release protections before exposing organization credentials', () => {
  let environmentReads = 0;
  const strong = currentEnvironment({ protection_rules: [{
    type: 'required_reviewers',
    prevent_self_review: true,
    reviewers: [{ type: 'Team', reviewer: { id: 42 } }, { type: 'User', reviewer: { id: 88951 } }],
  }, { type: 'wait_timer', wait_timer: 15 }, { type: 'branch_policy' }] });
  const base = readExecutor({ environment: strong });
  const writes = [];
  const execute = (args, input) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint.includes('/environments?')) {
      environmentReads += 1;
      const environment = environmentReads < 3 ? strong : currentEnvironment();
      return JSON.stringify({ total_count: 1, environments: [environment] });
    }
    if (args[0] === 'secret' || args.includes('POST') || args.includes('DELETE')) writes.push({ args, input });
    return base.execute(args, input);
  };
  const report = provisionFleet({
    targets: [target],
    reviewerId: 88951,
    username: 'release-user',
    password: 'release-password',
    apply: true,
    execute,
  });
  assert.match(report.failed.reason, /Release-environment verification failed/);
  assert.equal(writes.some(({ args }) => args[0] === 'secret'), false);
});

test('fleet apply verifies organization scope and preserves canonical environment copies', () => {
  const calls = [];
  let organizationConfigured = false;
  let environmentSecrets = ['WORDPRESS_ORG_PASSWORD'];
  let repositorySecrets = [];
  const execute = (args, input) => {
    calls.push({ args, input });
    const endpoint = args.find((argument) => argument.startsWith('repos/') || argument.startsWith('orgs/')) || '';
    if (endpoint === `repos/${target.repository}`) return JSON.stringify({ full_name: target.repository, owner: { login: 'stuttter' }, fork: false, archived: false, default_branch: 'master' });
    if (endpoint.includes('/environments?')) return JSON.stringify({ total_count: 1, environments: [currentEnvironment()] });
    if (endpoint.includes('/deployment-branch-policies?')) return JSON.stringify({ total_count: 1, branch_policies: [{ name: 'master', type: 'branch' }] });
    if (endpoint.includes('/environments/wordpress.org/secrets?')) return JSON.stringify({ total_count: environmentSecrets.length, secrets: environmentSecrets.map((name) => ({ name })) });
    if (endpoint.includes('/actions/secrets?') && endpoint.startsWith('repos/')) return JSON.stringify({ total_count: repositorySecrets.length, secrets: repositorySecrets.map((name) => ({ name })) });
    if (endpoint === 'orgs/stuttter/actions/secrets?per_page=100') {
      const names = organizationConfigured ? ['WORDPRESS_ORG_USERNAME', 'WORDPRESS_ORG_PASSWORD'] : [];
      return JSON.stringify({ total_count: names.length, secrets: names.map((name) => ({ name, visibility: 'selected' })) });
    }
    if (endpoint.includes('/repositories?')) return JSON.stringify({ total_count: 1, repositories: [{ full_name: target.repository }] });
    if (args[0] === 'secret') {
      organizationConfigured = true;
      return '';
    }
    return '{}';
  };
  const report = provisionFleet({
    targets: [target],
    reviewerId: 88951,
    username: 'release-user',
    password: 'release-password',
    apply: true,
    execute,
  });
  assert.equal(report.failed, null);
  assert.deepEqual(report.applied.map((result) => result.repository), [target.repository]);
  assert.deepEqual(report.prepared.map((result) => result.repository), [target.repository]);
  assert.deepEqual(report.applied[0].credential_copies_preserved, {
    repository: [],
    environment: ['WORDPRESS_ORG_PASSWORD'],
  });
  assert.deepEqual(report.cleanup_required, [{
    repository: target.repository,
    credential_copies: {
      repository: [],
      environment: ['WORDPRESS_ORG_PASSWORD'],
    },
  }]);
  assert.equal(calls.some(({ args }) => args.includes('DELETE')), false);
  assert.equal(environmentSecrets.length, 1);
  assert.equal(repositorySecrets.length, 0);
});

test('fleet reports prepared environment changes before a later organization failure', () => {
  let policyExists = false;
  const execute = (args, input) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/') || argument.startsWith('orgs/')) || '';
    if (endpoint === `repos/${target.repository}`) return JSON.stringify({ full_name: target.repository, owner: { login: 'stuttter' }, fork: false, archived: false, default_branch: 'master' });
    if (endpoint.includes('/environments?')) return JSON.stringify({ total_count: 1, environments: [currentEnvironment()] });
    if (endpoint.includes('/deployment-branch-policies?')) {
      const policies = policyExists ? [{ name: 'master', type: 'branch' }] : [];
      return JSON.stringify({ total_count: policies.length, branch_policies: policies });
    }
    if (endpoint.includes('/environments/wordpress.org/secrets?') || (endpoint.includes('/actions/secrets?') && endpoint.startsWith('repos/'))) {
      return JSON.stringify({ total_count: 0, secrets: [] });
    }
    const organizationOutput = organizationResponse(args);
    if (organizationOutput !== null) return organizationOutput;
    if (args.includes('POST')) {
      policyExists = true;
      return '';
    }
    if (args[0] === 'secret' && args.includes('WORDPRESS_ORG_PASSWORD')) throw new Error(`failed with ${input}`);
    if (args[0] === 'secret') return '';
    return '{}';
  };
  const report = provisionFleet({
    targets: [target],
    reviewerId: 88951,
    username: 'release-user',
    password: 'release-password',
    apply: true,
    execute,
  });
  assert.deepEqual(report.prepared, [{
    repository: target.repository,
    environment: 'wordpress.org',
    release_branch: 'master',
    changed: ['deployment_branch_policy'],
  }]);
  assert.deepEqual(report.changed, [
    { scope: 'environment', repository: target.repository, change: 'deployment_branch_policy' },
    { scope: 'organization', name: 'WORDPRESS_ORG_USERNAME', action: 'set' },
  ]);
  assert.match(report.failed.reason, /\[REDACTED\]/);
});

test('fleet failure redacts argument credentials and leaves copies when organization setup fails', () => {
  const duplicate = readExecutor({ environmentSecrets: ['WORDPRESS_ORG_PASSWORD'] });
  const execute = (args, input) => {
    if (args[0] === 'secret' && args.includes('WORDPRESS_ORG_PASSWORD')) throw new Error(`executor echoed ${input}`);
    return duplicate.execute(args, input);
  };
  const report = provisionFleet({
    targets: [target],
    reviewerId: 88951,
    username: 'argument-user',
    password: 'argument-password',
    apply: true,
    execute,
  });
  assert.equal(report.failed.reason.includes('argument-user'), false);
  assert.match(report.failed.reason, /\[REDACTED\]/);
  assert.equal(duplicate.calls.some((call) => call.args.includes('DELETE')), false);
  assert.deepEqual(report.prepared.map((result) => result.repository), [target.repository]);
  assert.deepEqual(report.changed, [{ scope: 'organization', name: 'WORDPRESS_ORG_USERNAME', action: 'set' }]);
});
