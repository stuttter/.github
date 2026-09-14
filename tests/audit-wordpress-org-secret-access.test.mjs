import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWordPressOrgSecretAccess } from '../scripts/audit-wordpress-org-secret-access.mjs';

const eligible = (repository) => ({
  repository,
  enabled: true,
  managed_paths: ['release'],
  manifest: { wordpress_org: true },
});

function inventory(...repositories) {
  return { repositories };
}

function executor({
  names = ['WORDPRESS_ORG_USERNAME', 'WORDPRESS_ORG_PASSWORD'],
  visibility = 'selected',
  repositories = ['stuttter/wp-chosen'],
  repositoriesByName = {},
  failAt = null,
} = {}) {
  const calls = [];
  const execute = (args) => {
    calls.push(args);
    const endpoint = args.at(-1);
    if (endpoint === failAt) throw new Error('GitHub API request failed.');
    if (endpoint === 'orgs/stuttter/actions/secrets?per_page=100') {
      return JSON.stringify({
        total_count: names.length,
        secrets: names.map((name) => ({ name, visibility })),
      });
    }
    const match = endpoint.match(/^orgs\/stuttter\/actions\/secrets\/(WORDPRESS_ORG_(?:USERNAME|PASSWORD))\/repositories\?per_page=100$/u);
    if (match) {
      const selectedRepositories = repositoriesByName[match[1]] || repositories;
      return JSON.stringify({
        total_count: selectedRepositories.length,
        repositories: selectedRepositories.map((full_name) => ({ full_name })),
      });
    }
    throw new Error(`Unexpected GitHub API call: ${endpoint}`);
  };
  return { calls, execute };
}

test('audit accepts selected visibility with the exact eligible repository set', () => {
  const github = executor({ repositories: ['stuttter/wp-chosen', 'stuttter/wp-user-groups'] });
  const report = auditWordPressOrgSecretAccess({
    inventory: inventory(eligible('stuttter/wp-user-groups'), eligible('stuttter/wp-chosen')),
    execute: github.execute,
  });

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.expected_repositories, ['stuttter/wp-chosen', 'stuttter/wp-user-groups']);
  assert.equal(github.calls.every((args) => args.includes('--method') && args.includes('GET')), true);
});

test('audit fails when either organization secret omits an eligible repository', () => {
  const github = executor({
    repositoriesByName: {
      WORDPRESS_ORG_USERNAME: ['stuttter/wp-chosen', 'stuttter/wp-user-groups'],
      WORDPRESS_ORG_PASSWORD: ['stuttter/wp-chosen'],
    },
  });
  const report = auditWordPressOrgSecretAccess({
    inventory: inventory(eligible('stuttter/wp-chosen'), eligible('stuttter/wp-user-groups')),
    execute: github.execute,
  });

  assert.equal(report.status, 'drift');
  assert.deepEqual(report.errors, ['WORDPRESS_ORG_PASSWORD is not scoped to the exact approved release repositories.']);
  assert.deepEqual(report.secrets.map((secret) => secret.selected_repositories), [
    ['stuttter/wp-chosen', 'stuttter/wp-user-groups'],
    ['stuttter/wp-chosen'],
  ]);
});

test('audit rejects extra selected repositories', () => {
  const github = executor({ repositories: ['stuttter/wp-chosen', 'stuttter/not-approved'] });
  const report = auditWordPressOrgSecretAccess({
    inventory: inventory(eligible('stuttter/wp-chosen')),
    execute: github.execute,
  });

  assert.equal(report.status, 'drift');
  assert.equal(report.errors.length, 2);
});

test('audit requires both secrets to use selected-repository visibility', () => {
  const broad = executor({ visibility: 'all' });
  const broadReport = auditWordPressOrgSecretAccess({
    inventory: inventory(eligible('stuttter/wp-chosen')),
    execute: broad.execute,
  });
  assert.equal(broadReport.status, 'drift');
  assert.equal(broadReport.errors.length, 2);
  assert.match(broadReport.errors.join(' '), /selected-repository visibility/u);

  const missing = executor({ names: ['WORDPRESS_ORG_USERNAME'] });
  const missingReport = auditWordPressOrgSecretAccess({
    inventory: inventory(eligible('stuttter/wp-chosen')),
    execute: missing.execute,
  });
  assert.equal(missingReport.status, 'drift');
  assert.match(missingReport.errors.join(' '), /missing the WORDPRESS_ORG_PASSWORD/u);
});

test('disabled, non-release, and non-WordPress.org repositories are excluded', () => {
  const disabled = { ...eligible('stuttter/disabled'), enabled: false };
  const unmanaged = { ...eligible('stuttter/unmanaged'), managed_paths: ['ci'] };
  const githubOnly = {
    ...eligible('stuttter/github-only'),
    manifest: { wordpress_org: false },
  };
  const github = executor();
  const report = auditWordPressOrgSecretAccess({
    inventory: inventory(eligible('stuttter/wp-chosen'), disabled, unmanaged, githubOnly),
    execute: github.execute,
  });

  assert.equal(report.status, 'clean');
  assert.deepEqual(report.expected_repositories, ['stuttter/wp-chosen']);
});

test('audit fails closed when GitHub metadata is unavailable or incomplete', () => {
  const endpoint = 'orgs/stuttter/actions/secrets/WORDPRESS_ORG_USERNAME/repositories?per_page=100';
  const failed = executor({ failAt: endpoint });
  assert.throws(
    () => auditWordPressOrgSecretAccess({
      inventory: inventory(eligible('stuttter/wp-chosen')),
      execute: failed.execute,
    }),
    /GitHub API request failed/u,
  );

  const incomplete = executor();
  const execute = (args) => {
    const output = incomplete.execute(args);
    if (args.at(-1) === endpoint) {
      const payload = JSON.parse(output);
      payload.total_count += 1;
      return JSON.stringify(payload);
    }
    return output;
  };
  assert.throws(
    () => auditWordPressOrgSecretAccess({
      inventory: inventory(eligible('stuttter/wp-chosen')),
      execute,
    }),
    /incomplete or malformed/u,
  );
});
