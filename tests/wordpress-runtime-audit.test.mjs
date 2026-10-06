import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRuntimeAudit, validateRuntimeContract } from '../scripts/audit-wordpress-runtime.mjs';

function runtimeFixture() {
  return {
    lock: {
      packages: {
        'node_modules/@simple-git/argv-parser': { version: '2.0.1' },
        'node_modules/@wordpress/env': { version: '11.16.0' },
        'node_modules/got': { version: '11.8.6' },
        'node_modules/cacheable-request': { version: '7.0.4' },
        'node_modules/http-cache-semantics': { version: '4.3.0' },
        'node_modules/js-yaml': { version: '4.3.2' },
        'node_modules/proxy-addr': { version: '2.0.8' },
        'node_modules/simple-git': { version: '4.0.2' },
      },
    },
    sources: {
      'wordpress.js': "const got = require('got');\nconst versions = await got('https://api.wordpress.org/').json();",
      'download-sources.js': "const got = require('got');\nconst { simpleGit: SimpleGit } = require( 'simple-git' );\nconst responseStream = got.stream(source.url);",
      'config/parse-config.js': 'module.exports = {};',
      'runtime/docker/download-wp-phpunit.js': "const { simpleGit: SimpleGit } = require( 'simple-git' );",
    },
  };
}

test('accepts a complete audit with no vulnerabilities', () => {
  const report = {
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  };
  assert.deepEqual(validateRuntimeAudit(report), []);
});

test('rejects every reported vulnerable package', () => {
  const report = {
    vulnerabilities: {
      'example-package': { severity: 'moderate', via: [] },
      'transitive-package': { severity: 'high', via: ['example-package'] },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 } },
  };
  assert.deepEqual(
    validateRuntimeAudit(report),
    ['npm audit reported vulnerable packages: example-package, transitive-package.'],
  );
});

test('rejects incomplete audit reports', () => {
  for (const report of [null, {}, { vulnerabilities: {} }, { vulnerabilities: {}, metadata: { vulnerabilities: {} } }]) {
    assert.deepEqual(validateRuntimeAudit(report), ['npm audit did not return a complete vulnerability report.']);
  }
});

test('accepts only the reviewed uncached wp-env runtime contract', () => {
  const { lock, sources } = runtimeFixture();
  assert.deepEqual(validateRuntimeContract(lock, sources, Date.parse('2026-10-03T00:00:00Z')), []);
});

test('rejects runtime version or request-path drift', () => {
  const { lock, sources } = runtimeFixture();
  lock.packages['node_modules/http-cache-semantics'].version = '4.4.0';
  sources['download-sources.js'] += '\nconst options = { cache: store };';
  const errors = validateRuntimeContract(lock, sources, Date.parse('2026-10-03T00:00:00Z'));
  assert.match(errors.join('\n'), /http-cache-semantics is not locked/u);
  assert.match(errors.join('\n'), /uncached got request paths/u);
});

test('rejects a missing or legacy simple-git compatibility import', () => {
  const { lock, sources } = runtimeFixture();
  sources['download-sources.js'] = sources['download-sources.js'].replace(
    "const { simpleGit: SimpleGit } = require( 'simple-git' );",
    "const SimpleGit = require( 'simple-git' );",
  );
  const errors = validateRuntimeContract(lock, sources, Date.parse('2026-10-03T00:00:00Z'));
  assert.match(errors.join('\n'), /simple-git 4 compatibility patch/u);
});

test('rejects nested overrides of reviewed runtime packages', () => {
  const { lock, sources } = runtimeFixture();
  lock.packages['node_modules/@wordpress/env/node_modules/got'] = { version: '11.8.5' };
  const errors = validateRuntimeContract(lock, sources, Date.parse('2026-10-03T00:00:00Z'));
  assert.match(errors.join('\n'), /got must be installed only at its reviewed top-level lockfile path/u);
});

test('rejects a missing runtime lockfile without throwing', () => {
  const { sources } = runtimeFixture();
  assert.doesNotThrow(() => validateRuntimeContract(undefined, sources, Date.parse('2026-10-03T00:00:00Z')));
  assert.match(
    validateRuntimeContract(undefined, sources, Date.parse('2026-10-03T00:00:00Z')).join('\n'),
    /@wordpress\/env must be installed only at its reviewed top-level lockfile path/u,
  );
});

test('expires the temporary applicability review', () => {
  const { lock, sources } = runtimeFixture();
  assert.match(
    validateRuntimeContract(lock, sources, Date.parse('2026-11-03T00:00:00Z')).join('\n'),
    /has expired/u,
  );
});
