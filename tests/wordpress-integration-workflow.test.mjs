import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/wordpress-plugin-ci.yml', import.meta.url), 'utf8');
const runtime = JSON.parse(readFileSync(new URL('../runtime/wordpress/package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../runtime/wordpress/package-lock.json', import.meta.url), 'utf8'));

test('integration selection comes only from immutable central inventory', () => {
  assert.equal((workflow.match(/integration-check-policy\.mjs --repository "\$\{TARGET_REPOSITORY\}" --project-root \./gu) || []).length, 2);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.metadata\.outputs\.integration_matrix\) \}\}/u);
  assert.doesNotMatch(workflow, /plugin-standard[^\n]*(?:command|script|smoke)/u);
});

test('Plugin Check scans the deterministic build without repository wp-env configuration', () => {
  assert.match(workflow, /WordPress\/plugin-check-action@10857da14b6c2246d15402b3e69f777edcf8c12e # v1\.1\.9/u);
  assert.match(workflow, /prepare-plugin-build\.sh/u);
  assert.match(workflow, /build-dir: \$\{\{ steps\.plugin-check-build\.outputs\.plugin_directory \}\}/u);
  assert.match(workflow, /\.wp-env\.json \.wp-env\.override\.json/u);
  assert.match(workflow, /repo-token: ''/u);
});

test('real WordPress cells use a fixed smoke path and no configured command', () => {
  const job = workflow.slice(
    workflow.indexOf('\n  wordpress-integration:'),
    workflow.indexOf('\n  artifact:'),
  );
  assert.match(job, /Run repository smoke test in real WordPress/u);
  assert.match(job, /run-wordpress-integration\.sh/u);
  assert.doesNotMatch(job, /matrix\.(?:command|script|path)/u);

  const runner = readFileSync(new URL('../scripts/run-wordpress-integration.sh', import.meta.url), 'utf8');
  assert.match(runner, /wp eval-file wp-content\/portfolio-integration-tests\/smoke\.php/u);
  assert.match(runner, /destroy --force --config=/u);
  assert.doesNotMatch(runner, /(?:eval|bash -c).*\$\{/u);
});

test('integration and Plugin Check are credential-free artifact gates', () => {
  assert.equal((workflow.match(/permissions: \{\}/gu) || []).length, 2);
  assert.match(workflow, /needs: \[metadata, syntax, quality, project-checks, plugin-check, wordpress-integration\]/u);
});

test('wp-env is exact, locked, and carries the audited transitive override', () => {
  assert.equal(runtime.dependencies['@wordpress/env'], '11.15.0');
  assert.equal(runtime.overrides.qs, '6.16.0');
  assert.equal(lock.packages['node_modules/@wordpress/env'].version, '11.15.0');
  assert.equal(lock.packages['node_modules/qs'].version, '6.16.0');
  assert.match(lock.packages['node_modules/@wordpress/env'].integrity, /^sha512-/u);
  assert.match(workflow, /patch-wordpress-env\.mjs/u);

  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (path === '') continue;
    assert.match(dependency.resolved, /^https:\/\/registry\.npmjs\.org\//u, path);
    assert.match(dependency.integrity, /^sha512-/u, path);
  }
});
