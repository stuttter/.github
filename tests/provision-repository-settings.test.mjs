import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTarget,
  commandArguments,
  desiredBranchProtection,
  desiredRepositorySettings,
  inspectTarget,
  provisionRepositorySettings,
  requiredCheckContexts,
  selectTargets,
} from '../scripts/provision-repository-settings.mjs';

const target = {
  repository: 'stuttter/example-plugin',
  enabled: true,
  managed_paths: ['ci', 'release', 'dependabot'],
  checks: {
    phpunit: { config: 'phpunit.xml.dist', files: [] },
    smoke: { single_site: 'tests/single.sh', multisite: 'tests/multi.sh' },
  },
  integration: {
    plugin_check: true,
    wordpress: { path: 'tests/integration/smoke.php', sha256: 'a'.repeat(64) },
  },
  protection: { extra_required_checks: ['Repository-specific gate'] },
  manifest: {
    minimum_php: '7.4',
    minimum_wordpress: '6.4',
    multisite: true,
    php_matrix: ['7.4', '8.4'],
    release_branch: 'master',
  },
};

function response(payload = null, status = 0, stderr = '') {
  return { status, stdout: payload === null ? '' : JSON.stringify(payload), stderr };
}

function branchProtection(overrides = {}) {
  const desired = desiredBranchProtection(target);
  return {
    required_status_checks: desired.required_status_checks,
    enforce_admins: { enabled: true },
    required_pull_request_reviews: desired.required_pull_request_reviews,
    restrictions: null,
    required_linear_history: { enabled: true },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    block_creations: { enabled: false },
    lock_branch: { enabled: false },
    allow_fork_syncing: { enabled: false },
    ...overrides,
  };
}

function executor({ metadata = {}, protection = branchProtection() } = {}) {
  const calls = [];
  const execute = (args, input) => {
    calls.push({ args, input });
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    const method = args[args.indexOf('--method') + 1];
    if (method !== 'GET') return response();
    if (endpoint === 'repos/stuttter/example-plugin') {
      return response({
        full_name: target.repository,
        owner: { login: 'stuttter' },
        fork: false,
        archived: false,
        default_branch: 'master',
        ...desiredRepositorySettings(),
        security_and_analysis: {
          dependabot_security_updates: { status: 'enabled' },
          secret_scanning: { status: 'enabled' },
          secret_scanning_push_protection: { status: 'enabled' },
        },
        ...metadata,
      });
    }
    if (endpoint.endsWith('/commits/master')) {
      return response({ sha: 'b'.repeat(40), commit: { verification: { verified: true } } });
    }
    if (endpoint.endsWith(`/commits/${'b'.repeat(40)}/check-runs?per_page=100`)) {
      const check_runs = requiredCheckContexts(target).map((name, index) => ({
        id: 1000 + index,
        name,
        app: { id: 15368 },
        status: 'completed',
        conclusion: 'success',
      }));
      return response({ total_count: check_runs.length, check_runs });
    }
    if (endpoint.endsWith('/rulesets?includes_parents=true')) {
      return response([{ id: 42, enforcement: 'active', target: 'branch' }]);
    }
    if (endpoint.endsWith('/rulesets/42')) {
      return response({
        conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
        rules: [{ type: 'required_signatures' }],
      });
    }
    if (endpoint.endsWith('/vulnerability-alerts')) return response();
    if (endpoint.includes('/branches/master/protection')) {
      return protection === null ? response(null, 1, 'HTTP 404: Not Found') : response(protection);
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  return { calls, execute };
}

test('command arguments and target selection keep apply fleet-wide', () => {
  assert.deepEqual(commandArguments([]), { help: false, mode: 'audit', requested: 'all' });
  assert.deepEqual(commandArguments(['audit', target.repository]), { help: false, mode: 'audit', requested: target.repository });
  assert.throws(() => commandArguments(['apply', target.repository]), /complete enabled portfolio/);
  assert.deepEqual(selectTargets({ repositories: [target, { ...target, repository: 'stuttter/disabled', enabled: false }] }), [target]);
  assert.throws(() => selectTargets({ repositories: [target] }, 'stuttter/missing'), /not an enabled portfolio target/);
  assert.throws(() => provisionRepositorySettings({ inventory: { repositories: [target] }, mode: 'audti' }), /Mode must be audit or apply/);
  assert.throws(
    () => provisionRepositorySettings({ inventory: { repositories: [target] }, mode: 'apply', requested: target.repository }),
    /complete enabled portfolio/,
  );
});

test('required checks are deterministic and preserve declared local gates', () => {
  assert.deepEqual(requiredCheckContexts(target), [
    'Repository-specific gate',
    'validate / Metadata',
    'validate / Minimum PHP 7.4 tests',
    'validate / Multisite smoke',
    'validate / PHP 7.4 syntax',
    'validate / PHP 8.4 syntax',
    'validate / Production artifact',
    'validate / Project quality suite',
    'validate / Single-site smoke',
    'validate / WordPress 6.4 / PHP 7.4 / multisite',
    'validate / WordPress Plugin Check',
    'validate / WordPress stable / PHP 8.4 / multisite',
    'validate / WordPress trunk / PHP 8.4 / multisite',
  ]);
  assert.ok(desiredBranchProtection(target).required_status_checks.checks.every((check) => check.app_id === 15368));
  const withoutMatrix = { ...target, manifest: { ...target.manifest } };
  delete withoutMatrix.manifest.php_matrix;
  assert.ok(requiredCheckContexts(withoutMatrix).includes('validate / PHP 7.4 syntax'));
});

test('clean inspection verifies ownership, signatures, settings, protection, and security', () => {
  const clean = executor();
  assert.deepEqual(inspectTarget({ target, execute: clean.execute }), {
    repository: target.repository,
    release_branch: 'master',
    errors: [],
    drift: [],
  });
});

test('inspection reports settings, protection, and security drift without writing', () => {
  const drifted = executor({
    metadata: {
      allow_merge_commit: true,
      delete_branch_on_merge: false,
      security_and_analysis: {
        secret_scanning: { status: 'disabled' },
        secret_scanning_push_protection: { status: 'disabled' },
      },
    },
    protection: null,
  });
  const inspection = inspectTarget({ target, execute: drifted.execute });
  assert.deepEqual(inspection.errors, []);
  assert.deepEqual(inspection.drift, [
    'branch_protection',
    'repository.allow_merge_commit',
    'repository.delete_branch_on_merge',
    'security.dependabot_updates',
    'security.push_protection',
    'security.secret_scanning',
  ]);
  assert.equal(drifted.calls.every((call) => call.args.includes('GET')), true);
});

test('inspection fails closed when the all-branch signature rule is absent', () => {
  const base = executor();
  const execute = (args, input) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint.endsWith('/rulesets/42')) {
      return response({ conditions: { ref_name: { include: ['refs/heads/master'] } }, rules: [{ type: 'required_signatures' }] });
    }
    return base.execute(args, input);
  };
  assert.match(inspectTarget({ target, execute }).errors.join(' '), /signed-commit rule for every branch/);

  const excluded = executor();
  const excludingExecute = (args, input) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint.endsWith('/rulesets/42')) {
      return response({ conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/legacy'] } }, rules: [{ type: 'required_signatures' }] });
    }
    return excluded.execute(args, input);
  };
  assert.match(inspectTarget({ target, execute: excludingExecute }).errors.join(' '), /signed-commit rule for every branch/);
});

test('inspection compares every fixed pull-request protection field', () => {
  const protection = branchProtection({
    required_pull_request_reviews: {
      ...desiredBranchProtection(target).required_pull_request_reviews,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
    },
  });
  assert.deepEqual(inspectTarget({ target, execute: executor({ protection }).execute }).drift, [
    'branch.code_owner_reviews',
    'branch.last_push_approval',
  ]);
  const absentRestrictions = { ...branchProtection() };
  delete absentRestrictions.restrictions;
  assert.deepEqual(inspectTarget({ target, execute: executor({ protection: absentRestrictions }).execute }).drift, []);
});

test('inspection rejects unsigned heads, missing required checks, and failed checks', () => {
  const base = executor();
  const unsigned = (args, input) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint.endsWith('/commits/master')) return response({ sha: 'b'.repeat(40), commit: { verification: { verified: false } } });
    return base.execute(args, input);
  };
  assert.match(inspectTarget({ target, execute: unsigned }).errors.join(' '), /verified signed default-branch head/);

  for (const mode of ['missing', 'failed']) {
    const mocked = executor();
    const execute = (args, input) => {
      const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
      if (endpoint.includes('/check-runs?per_page=100')) {
        const contexts = requiredCheckContexts(target);
        const check_runs = contexts.slice(mode === 'missing' ? 1 : 0).map((name, index) => ({
          id: 1000 + index,
          name,
          app: { id: 15368 },
          status: 'completed',
          conclusion: mode === 'failed' && index === 0 ? 'failure' : 'success',
        }));
        return response({ total_count: check_runs.length, check_runs });
      }
      return mocked.execute(args, input);
    };
    assert.match(
      inspectTarget({ target, execute }).errors.join(' '),
      mode === 'missing' ? /has never reported required check/ : /does not have a successful/,
    );
  }
});

test('inspection accepts only the newest matching GitHub Actions check run', () => {
  for (const mode of ['wrong-app', 'newer-failure']) {
    const mocked = executor();
    const execute = (args, input) => {
      const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
      if (endpoint.includes('/check-runs?per_page=100')) {
        const check_runs = requiredCheckContexts(target).flatMap((name, index) => {
          const success = { id: 1000 + index, name, app: { id: 15368 }, conclusion: 'success' };
          if (index !== 0) return [success];
          if (mode === 'wrong-app') return [{ ...success, app: { id: 7 } }];
          return [success, { ...success, id: 2000 + index, conclusion: 'failure' }];
        });
        return response({ total_count: check_runs.length, check_runs });
      }
      return mocked.execute(args, input);
    };
    assert.match(
      inspectTarget({ target, execute }).errors.join(' '),
      mode === 'wrong-app' ? /from GitHub Actions/ : /successful latest/,
    );
  }
});

test('apply writes only the fixed settings, protection, and ordered Dependabot endpoints', () => {
  const mocked = executor();
  const inspection = { repository: target.repository, errors: [], drift: ['branch.required_checks'] };
  assert.deepEqual(applyTarget({ target, inspection, execute: mocked.execute }), {
    repository: target.repository,
    changed: ['branch.required_checks'],
  });
  const writes = mocked.calls.filter((call) => !call.args.includes('GET'));
  assert.equal(writes.length, 4);
  assert.ok(writes.some((call) => call.args.includes('PATCH') && call.args.includes('repos/stuttter/example-plugin')));
  assert.ok(writes.some((call) => call.args.includes('PUT') && call.args.some((argument) => argument.includes('/branches/master/protection'))));
  assert.ok(writes.some((call) => call.args.includes('PUT') && call.args.some((argument) => argument.endsWith('/vulnerability-alerts'))));
  assert.ok(writes.some((call) => call.args.includes('PUT') && call.args.some((argument) => argument.endsWith('/automated-security-fixes'))));
  assert.ok(
    writes.findIndex((call) => call.args.some((argument) => argument.endsWith('/vulnerability-alerts'))) <
      writes.findIndex((call) => call.args.some((argument) => argument.endsWith('/automated-security-fixes'))),
  );
});

test('inspection reports disabled vulnerability alerts separately from security updates', () => {
  const mocked = executor();
  const execute = (args, input) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint.endsWith('/vulnerability-alerts')) return response(null, 1, 'HTTP 404: Not Found');
    return mocked.execute(args, input);
  };
  assert.deepEqual(inspectTarget({ target, execute }).drift, ['security.dependabot_alerts']);
});

test('fleet apply stops before mutation when any target fails preflight', () => {
  const base = executor();
  const execute = (args, input) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint.endsWith('/rulesets/42')) return response({ conditions: { ref_name: { include: [] } }, rules: [] });
    return base.execute(args, input);
  };
  const report = provisionRepositorySettings({ inventory: { repositories: [target] }, mode: 'apply', execute });
  assert.equal(report.inspections[0].errors.length, 1);
  assert.deepEqual(report.changed, []);
  assert.equal(base.calls.every((call) => call.args.includes('GET')), true);
});

test('fleet apply repeats the complete safety preflight before its first write', () => {
  const base = executor();
  let rulesetReads = 0;
  const execute = (args, input) => {
    const endpoint = args.find((argument) => argument.startsWith('repos/')) || '';
    if (endpoint.endsWith('/rulesets/42')) {
      rulesetReads += 1;
      if (rulesetReads > 1) return response({ conditions: { ref_name: { include: [] } }, rules: [] });
    }
    return base.execute(args, input);
  };
  const report = provisionRepositorySettings({ inventory: { repositories: [target] }, mode: 'apply', execute });
  assert.equal(report.revalidation[0].errors.length, 1);
  assert.deepEqual(report.changed, []);
  assert.equal(base.calls.every((call) => call.args.includes('GET')), true);
});

test('fleet inspection reports every repository when one read fails', () => {
  const base = executor();
  let metadataReads = 0;
  const execute = (args, input) => {
    if (args.includes('repos/stuttter/example-plugin') && args.includes('GET')) {
      metadataReads += 1;
      if (metadataReads === 1) return response(null, 1, 'temporary API failure');
    }
    return base.execute(args, input);
  };
  const report = provisionRepositorySettings({ inventory: { repositories: [target, target] }, execute });
  assert.equal(report.inspections.length, 2);
  assert.match(report.inspections[0].errors[0], /temporary API failure/);
  assert.deepEqual(report.inspections[1].errors, []);
});

test('fleet apply records write failures and always verifies every target', () => {
  const base = executor();
  let failed = false;
  const execute = (args, input) => {
    if (!args.includes('GET') && !failed) {
      failed = true;
      return response(null, 1, 'write failed');
    }
    return base.execute(args, input);
  };
  const report = provisionRepositorySettings({ inventory: { repositories: [target, target] }, mode: 'apply', execute });
  assert.equal(report.apply_errors.length, 1);
  assert.match(report.apply_errors[0].error, /write failed/);
  assert.equal(report.changed.length, 1);
  assert.equal(report.verification.length, 2);
});
