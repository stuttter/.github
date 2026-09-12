import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReleaseEnvironment,
  commandArguments,
  currentEnvironmentConfiguration,
  githubChildEnvironment,
  githubFailure,
  inspectReleaseEnvironment,
  protectedEnvironment,
  provisionFleet,
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

function readExecutor({ environment = currentEnvironment(), policies = [{ name: 'master', type: 'branch' }], secrets = [] } = {}) {
  const calls = [];
  const execute = (args, input) => {
    calls.push({ args, input });
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint === 'repos/stuttter/example-plugin') {
      return JSON.stringify({ full_name: target.repository, owner: { login: 'stuttter' }, fork: false, archived: false, default_branch: 'master' });
    }
    if (endpoint.includes('/environments?')) return JSON.stringify({ total_count: 1, environments: [environment] });
    if (endpoint.includes('/deployment-branch-policies?')) return JSON.stringify({ total_count: policies.length, branch_policies: policies });
    if (endpoint.includes('/secrets?')) return JSON.stringify({ total_count: secrets.length, secrets: secrets.map((name) => ({ name })) });
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
  assert.deepEqual(commandArguments([]), { mode: 'audit', requested: 'all' });
  assert.deepEqual(commandArguments(['apply', 'stuttter/example-plugin']), { mode: 'apply', requested: 'stuttter/example-plugin' });
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
  assert.equal(calls.filter((call) => call.args.some((argument) => argument.includes('?per_page=100'))).length, 3);
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

test('inspection rejects duplicate policies and unrelated environment secrets', () => {
  const duplicate = readExecutor({ policies: [{ name: 'master', type: 'branch' }, { name: 'master', type: 'branch' }] });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: duplicate.execute }).errors.join(' '), /duplicate wordpress\.org release branch policies/i);
  const extraSecret = readExecutor({ secrets: ['WORDPRESS_ORG_USERNAME', 'UNRELATED_SECRET'] });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: extraSecret.execute }).errors.join(' '), /unexpected wordpress\.org secrets/i);
});

test('inspection rejects a seventh required reviewer before mutation', () => {
  const reviewers = Array.from({ length: 6 }, (_value, index) => ({ type: 'Team', reviewer: { id: index + 1 } }));
  const full = readExecutor({ environment: currentEnvironment({
    protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers }, { type: 'branch_policy' }],
  }) });
  assert.match(inspectReleaseEnvironment({ target, reviewerId: 88951, execute: full.execute }).errors.join(' '), /six-reviewer limit/);
  assert.equal(full.calls.some((call) => call.args.includes('PUT') || call.args[0] === 'secret'), false);
});

test('apply passes secrets only through standard input', () => {
  const { calls, execute } = readExecutor();
  const inspection = inspectReleaseEnvironment({ target, reviewerId: 88951, execute });
  applyReleaseEnvironment({ inspection, username: 'release-user', password: 'application-password', execute });
  const secretCalls = calls.filter((call) => call.args[0] === 'secret');
  assert.equal(secretCalls.length, 2);
  assert.equal(calls.some((call) => call.args.includes('release-user') || call.args.includes('application-password')), false);
  assert.deepEqual(secretCalls.map((call) => call.input), ['release-user', 'application-password']);
});

test('apply does not rewrite already-correct environment protections', () => {
  const { calls, execute } = readExecutor();
  const inspection = inspectReleaseEnvironment({ target, reviewerId: 88951, execute });
  applyReleaseEnvironment({ inspection, username: 'release-user', password: 'application-password', execute });
  assert.equal(calls.some((call) => call.args.includes('PUT')), false);
});

test('fleet failure redacts credentials passed as function arguments', () => {
  const { execute: baseExecute } = readExecutor();
  const execute = (args, input) => {
    if (args[0] === 'secret') throw new Error(`executor echoed ${input}`);
    return baseExecute(args, input);
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
});

test('apply sends only the documented branch policy name when creating one', () => {
  const { calls, execute } = readExecutor({ policies: [] });
  const inspection = inspectReleaseEnvironment({ target, reviewerId: 88951, execute });
  applyReleaseEnvironment({ inspection, username: 'release-user', password: 'application-password', execute });
  const policyCall = calls.find((call) => call.args.includes('POST'));
  assert.deepEqual(JSON.parse(policyCall.input), { name: 'master' });
});

test('fleet apply makes no changes when any target fails preflight', () => {
  const targets = [target, { ...target, repository: 'stuttter/second-plugin' }];
  const calls = [];
  const execute = (args, input) => {
    calls.push({ args, input });
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    const repository = endpoint.includes('second-plugin') ? 'stuttter/second-plugin' : target.repository;
    if (endpoint === `repos/${repository}`) return JSON.stringify({ full_name: repository, owner: { login: 'stuttter' }, fork: false, archived: false, default_branch: 'master' });
    if (endpoint.includes('/environments?')) return JSON.stringify({ total_count: 1, environments: [currentEnvironment({ can_admins_bypass: repository === target.repository ? false : true })] });
    if (endpoint.includes('/deployment-branch-policies?')) return JSON.stringify({ total_count: 1, branch_policies: [{ name: 'master', type: 'branch' }] });
    if (endpoint.includes('/secrets?')) return JSON.stringify({ total_count: 0, secrets: [] });
    return '{}';
  };
  const report = provisionFleet({ targets, reviewerId: 88951, username: 'release-user', password: 'release-password', apply: true, execute });
  assert.equal(report.applied.length, 0);
  assert.match(report.failed.reason, /no changes were made/);
  assert.equal(calls.some((call) => call.args.includes('PUT') || call.args[0] === 'secret'), false);
});

test('fleet audit fails when inspection finds unsafe configuration', () => {
  const bypass = readExecutor({ environment: currentEnvironment({ can_admins_bypass: true }) });
  const report = provisionFleet({ targets: [target], reviewerId: 88951, apply: false, execute: bypass.execute });
  assert.equal(report.failed.repository, target.repository);
  assert.match(report.failed.reason, /audit found unsafe configuration/);
  assert.deepEqual(report.pending, []);
  assert.equal(bypass.calls.some((call) => call.args.includes('PUT') || call.args[0] === 'secret'), false);
});

test('fleet preflight reports a read exception and still inspects later targets without writing', () => {
  const targets = [target, { ...target, repository: 'stuttter/second-plugin' }, { ...target, repository: 'stuttter/third-plugin' }];
  const reads = [];
  const execute = (args) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint === 'repos/stuttter/second-plugin') throw new Error('simulated read failure');
    if (/^repos\/stuttter\/[^/]+$/.test(endpoint)) {
      reads.push(endpoint);
      return JSON.stringify({ full_name: endpoint.slice(6), owner: { login: 'stuttter' }, fork: false, archived: false, default_branch: 'master' });
    }
    if (endpoint.includes('/environments?')) return JSON.stringify({ total_count: 1, environments: [currentEnvironment()] });
    if (endpoint.includes('/deployment-branch-policies?')) return JSON.stringify({ total_count: 1, branch_policies: [{ name: 'master', type: 'branch' }] });
    if (endpoint.includes('/secrets?')) return JSON.stringify({ total_count: 0, secrets: [] });
    assert.fail(`Unexpected write: ${args.join(' ')}`);
  };
  const report = provisionFleet({ targets, reviewerId: 88951, username: 'release-user', password: 'release-password', apply: true, execute });
  assert.equal(report.applied.length, 0);
  assert.equal(report.failed.repository, 'stuttter/second-plugin');
  assert.match(report.failed.reason, /simulated read failure/);
  assert.deepEqual(reads, ['repos/stuttter/example-plugin', 'repos/stuttter/third-plugin']);
  assert.deepEqual(report.pending, targets.map((candidate) => candidate.repository));
});

test('fleet apply reports completed, failed, and pending targets after a write failure', () => {
  const targets = [target, { ...target, repository: 'stuttter/second-plugin' }, { ...target, repository: 'stuttter/third-plugin' }];
  const secretState = new Map();
  const execute = (args, input) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    const shortName = ['second-plugin', 'third-plugin'].find((name) => endpoint.includes(name));
    const fullName = shortName ? `stuttter/${shortName}` : target.repository;
    if (endpoint === `repos/${fullName}`) return JSON.stringify({ full_name: fullName, owner: { login: 'stuttter' }, fork: false, archived: false, default_branch: 'master' });
    if (endpoint.includes('/environments?')) return JSON.stringify({ total_count: 1, environments: [currentEnvironment()] });
    if (endpoint.includes('/deployment-branch-policies?')) return JSON.stringify({ total_count: 1, branch_policies: [{ name: 'master', type: 'branch' }] });
    if (args[0] === 'secret') {
      const repository = args[args.indexOf('--repo') + 1];
      if (repository === 'stuttter/second-plugin') throw new Error('simulated write failure');
      secretState.set(repository, ['WORDPRESS_ORG_USERNAME', 'WORDPRESS_ORG_PASSWORD']);
      return '';
    }
    if (endpoint.includes('/secrets?')) {
      const names = secretState.get(fullName) || [];
      return JSON.stringify({ total_count: names.length, secrets: names.map((name) => ({ name })) });
    }
    return '{}';
  };
  const report = provisionFleet({ targets, reviewerId: 88951, username: 'release-user', password: 'release-password', apply: true, execute });
  assert.deepEqual(report.applied.map((result) => result.repository), [target.repository]);
  assert.equal(report.failed.repository, 'stuttter/second-plugin');
  assert.deepEqual(report.pending, ['stuttter/third-plugin']);
});

test('post-write verification rejects lost stronger protections', () => {
  let environmentReads = 0;
  const strong = currentEnvironment({ protection_rules: [{
    type: 'required_reviewers',
    prevent_self_review: true,
    reviewers: [{ type: 'Team', reviewer: { id: 42 } }, { type: 'User', reviewer: { id: 88951 } }],
  }, { type: 'wait_timer', wait_timer: 15 }, { type: 'branch_policy' }] });
  const execute = (args) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint === 'repos/stuttter/example-plugin') return JSON.stringify({ full_name: target.repository, owner: { login: 'stuttter' }, fork: false, archived: false, default_branch: 'master' });
    if (endpoint.includes('/environments?')) {
      environmentReads += 1;
      const environment = environmentReads < 3 ? strong : currentEnvironment();
      return JSON.stringify({ total_count: 1, environments: [environment] });
    }
    if (endpoint.includes('/deployment-branch-policies?')) return JSON.stringify({ total_count: 1, branch_policies: [{ name: 'master', type: 'branch' }] });
    if (endpoint.includes('/secrets?')) return JSON.stringify({ total_count: 2, secrets: [{ name: 'WORDPRESS_ORG_USERNAME' }, { name: 'WORDPRESS_ORG_PASSWORD' }] });
    return '{}';
  };
  const report = provisionFleet({ targets: [target], reviewerId: 88951, username: 'release-user', password: 'release-password', apply: true, execute });
  assert.equal(report.applied.length, 0);
  assert.match(report.failed.reason, /Post-write verification failed/);
});
