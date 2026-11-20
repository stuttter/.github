#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = resolve(repositoryRoot, 'runtime/wordpress');
const expectedVersions = {
  '@simple-git/argv-parser': '2.0.1',
  '@wordpress/env': '11.16.0',
  'body-parser': '1.20.9',
  got: '11.8.6',
  'cacheable-request': '7.0.4',
  express: '4.22.3',
  'fast-xml-parser': '5.12.0',
  'fast-uri': '3.1.9',
  glob: '14.0.3',
  'http-cache-semantics': '4.3.0',
  'js-yaml': '4.3.2',
  minimatch: '11.0.3',
  'proxy-addr': '2.0.8',
  qs: '6.17.1',
  rimraf: '6.1.3',
  'simple-git': '4.0.2',
};
const reviewedPlaygroundAudit = {
  counts: { info: 0, low: 0, moderate: 4, high: 1, critical: 0, total: 5 },
  vulnerabilities: {
    '@wp-playground/blueprints': {
      name: '@wp-playground/blueprints',
      severity: 'moderate',
      isDirect: false,
      via: ['@wp-playground/storage'],
      effects: ['@wp-playground/cli', '@wp-playground/tools'],
      range: '1.0.5 || 3.0.16 || >=3.1.17',
      nodes: ['node_modules/@wp-playground/blueprints'],
      fixAvailable: true,
    },
    '@wp-playground/cli': {
      name: '@wp-playground/cli',
      severity: 'moderate',
      isDirect: false,
      via: ['@wp-playground/blueprints', '@wp-playground/storage', '@wp-playground/tools'],
      effects: [],
      range: '1.0.5 || 3.0.16 || 3.0.30 || >=3.1.17',
      nodes: ['node_modules/@wp-playground/cli'],
      fixAvailable: true,
    },
    '@wp-playground/storage': {
      name: '@wp-playground/storage',
      severity: 'moderate',
      isDirect: false,
      via: ['isomorphic-git'],
      effects: ['@wp-playground/blueprints', '@wp-playground/cli'],
      range: '>=3.1.28',
      nodes: ['node_modules/@wp-playground/storage'],
      fixAvailable: true,
    },
    '@wp-playground/tools': {
      name: '@wp-playground/tools',
      severity: 'moderate',
      isDirect: false,
      via: ['@wp-playground/blueprints'],
      effects: ['@wp-playground/cli'],
      range: '>=3.1.18',
      nodes: ['node_modules/@wp-playground/tools'],
      fixAvailable: true,
    },
    'isomorphic-git': {
      name: 'isomorphic-git',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1244996,
          name: 'isomorphic-git',
          dependency: 'isomorphic-git',
          url: 'https://github.com/advisories/GHSA-cw2g-2vwq-88w6',
          severity: 'moderate',
          range: '<=1.38.5',
        },
        {
          source: 1244997,
          name: 'isomorphic-git',
          dependency: 'isomorphic-git',
          url: 'https://github.com/advisories/GHSA-96wc-2m84-2cj7',
          severity: 'moderate',
          range: '<=1.38.5',
        },
        {
          source: 1244998,
          name: 'isomorphic-git',
          dependency: 'isomorphic-git',
          url: 'https://github.com/advisories/GHSA-9qw7-j9xw-fv9c',
          severity: 'high',
          range: '<=1.38.5',
        },
      ],
      effects: ['@wp-playground/storage'],
      range: '<=1.38.5',
      nodes: ['node_modules/@wp-playground/storage/node_modules/isomorphic-git'],
      fixAvailable: true,
    },
  },
};
const compatibilityProbe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const { rimraf } = require('rimraf');
  require('glob');
  require('minimatch');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpress-runtime-rimraf-'));
  fs.mkdirSync(path.join(directory, 'nested'));
  fs.writeFileSync(path.join(directory, 'nested', 'file'), 'runtime smoke');
  await rimraf(directory);
  assert.equal(fs.existsSync(directory), false);

  const express = require('express');
  const app = express();
  app.set('query parser', 'extended');
  app.use(express.urlencoded({ extended: true }));
  app.post('/probe', (request, response) => {
    response.json({ body: request.body, query: request.query });
  });

  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    candidate.on('error', reject);
  });
  try {
    const address = server.address();
    const response = await fetch(
      'http://127.0.0.1:' + address.port + '/probe?nested%5Bvalue%5D=query',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'nested%5Bvalue%5D=body',
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      body: { nested: { value: 'body' } },
      query: { nested: { value: 'query' } },
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

function sameValues(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function normalizeVulnerability(vulnerability) {
  return {
    name: vulnerability?.name,
    severity: vulnerability?.severity,
    isDirect: vulnerability?.isDirect,
    via: (vulnerability?.via ?? []).map((item) => typeof item === 'string' ? item : {
      source: item.source,
      name: item.name,
      dependency: item.dependency,
      url: item.url,
      severity: item.severity,
      range: item.range,
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    effects: [...(vulnerability?.effects ?? [])].sort(),
    range: vulnerability?.range,
    nodes: [...(vulnerability?.nodes ?? [])].sort(),
    fixAvailable: vulnerability?.fixAvailable,
  };
}

function matchesReviewedPlaygroundAudit(vulnerabilities, counts) {
  const names = Object.keys(vulnerabilities).sort();
  const expectedNames = Object.keys(reviewedPlaygroundAudit.vulnerabilities).sort();
  if (!sameValues(names, expectedNames)) return false;

  const normalized = Object.fromEntries(expectedNames.map((name) => [
    name,
    normalizeVulnerability(vulnerabilities[name]),
  ]));
  return JSON.stringify({ counts, vulnerabilities: normalized }) === JSON.stringify(reviewedPlaygroundAudit);
}

function matchesInactivePlaygroundContract(lock, integrationRunnerSource, integrationWorkflowSource) {
  const packages = lock?.packages ?? {};
  const isomorphicGitPaths = Object.keys(packages).filter(
    (path) => path === 'node_modules/isomorphic-git' || path.endsWith('/node_modules/isomorphic-git'),
  );
  const storage = packages['node_modules/@wp-playground/storage'];
  const isomorphicGit = packages['node_modules/@wp-playground/storage/node_modules/isomorphic-git'];
  const activeStartLines = integrationRunnerSource
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line) && /\bstart\b/u.test(line))
    .map((line) => line.trim());
  const expectedStartLine = '"${wp_env}" start --update --runtime=docker --config="${config}"';
  const workflowRunnerReferences = integrationWorkflowSource.match(/run-wordpress-integration\.sh/gu) ?? [];
  const workflowWpEnvReferences = integrationWorkflowSource.match(
    /\.portfolio-standard\/runtime\/wordpress\/node_modules\/\.bin\/wp-env/gu,
  ) ?? [];
  const expectedWorkflowInvocation = /bash \.portfolio-standard\/scripts\/run-wordpress-integration\.sh\s+\.portfolio-standard\/runtime\/wordpress\/node_modules\/\.bin\/wp-env\s+"\$\{\{ steps\.integration-config\.outputs\.config \}\}"/u;
  return (
    storage?.version === '3.1.53' &&
    storage?.dependencies?.['isomorphic-git'] === '1.37.6' &&
    isomorphicGit?.version === '1.37.6' &&
    sameValues(isomorphicGitPaths, ['node_modules/@wp-playground/storage/node_modules/isomorphic-git']) &&
    sameValues(activeStartLines, [expectedStartLine]) &&
    !/playground/iu.test(integrationRunnerSource) &&
    workflowRunnerReferences.length === 1 &&
    workflowWpEnvReferences.length === 1 &&
    expectedWorkflowInvocation.test(integrationWorkflowSource) &&
    !/wp-playground/iu.test(integrationWorkflowSource)
  );
}

function readJavaScriptSources(directory, root = directory) {
  const sources = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === '__tests__') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(sources, readJavaScriptSources(path, root));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      sources[path.slice(root.length + 1)] = readFileSync(path, 'utf8');
    }
  }
  return sources;
}

export function validateRuntimeAudit(
  report,
  lock,
  integrationRunnerSource = '',
  integrationWorkflowSource = '',
) {
  const vulnerabilities = report?.vulnerabilities;
  const counts = report?.metadata?.vulnerabilities;

  if (!vulnerabilities || !counts || !Number.isInteger(counts.total)) {
    return ['npm audit did not return a complete vulnerability report.'];
  }

  const names = Object.keys(vulnerabilities);
  if (counts.total === 0 && names.length === 0) return [];
  if (
    matchesReviewedPlaygroundAudit(vulnerabilities, counts) &&
    matchesInactivePlaygroundContract(lock, integrationRunnerSource, integrationWorkflowSource)
  ) {
    return [];
  }
  return [`npm audit reported vulnerable packages: ${names.join(', ') || 'unknown'}.`];
}

export function validateRuntimeContract(lock, wordpressSources) {
  const errors = [];
  const packages = lock?.packages ?? {};
  const packagePaths = Object.keys(packages);
  for (const [name, version] of Object.entries(expectedVersions)) {
    const expectedPath = `node_modules/${name}`;
    const installedPaths = packagePaths.filter(
      (path) => path === expectedPath || path.endsWith(`/node_modules/${name}`),
    );
    if (installedPaths.length !== 1 || installedPaths[0] !== expectedPath) {
      errors.push(`${name} must be installed only at its reviewed top-level lockfile path.`);
    } else if (packages[expectedPath]?.version !== version) {
      errors.push(`${name} is not locked to the reviewed ${version} version.`);
    }
  }

  const gotSources = Object.entries(wordpressSources).filter(([, source]) => /\bgot\b/u.test(source));
  const wordpressSource = wordpressSources['wordpress.js'] ?? '';
  const downloadSource = wordpressSources['download-sources.js'] ?? '';
  const phpunitDownloadSource = wordpressSources['runtime/docker/download-wp-phpunit.js'] ?? '';
  const allSources = Object.values(wordpressSources).join('\n');
  if (
    !sameValues(gotSources.map(([path]) => path), ['download-sources.js', 'wordpress.js']) ||
    (wordpressSource.match(/\bgot\b/gu) ?? []).length !== 3 ||
    (wordpressSource.match(/\bgot\s*\(/gu) ?? []).length !== 1 ||
    /\bgot\s*\./u.test(wordpressSource) ||
    (downloadSource.match(/\bgot\b/gu) ?? []).length !== 3 ||
    (downloadSource.match(/\bgot\.stream\s*\(/gu) ?? []).length !== 1 ||
    /\bgot\s*\(/u.test(downloadSource) ||
    /\bcacheable-request\b/u.test(allSources) ||
    /\bcache\s*:/u.test(allSources)
  ) {
    errors.push('@wordpress/env no longer matches the reviewed uncached got request paths.');
  }

  const simpleGitSources = Object.entries(wordpressSources)
    .filter(([, source]) => /require\( 'simple-git' \)/u.test(source));
  if (
    !sameValues(
      simpleGitSources.map(([path]) => path),
      ['download-sources.js', 'runtime/docker/download-wp-phpunit.js'],
    ) ||
    (downloadSource.match(/const \{ simpleGit: SimpleGit \} = require\( 'simple-git' \);/gu) ?? []).length !== 1 ||
    (phpunitDownloadSource.match(/const \{ simpleGit: SimpleGit \} = require\( 'simple-git' \);/gu) ?? []).length !== 1 ||
    /const SimpleGit = require\( 'simple-git' \);/u.test(allSources)
  ) {
    errors.push('@wordpress/env no longer matches the reviewed simple-git 4 compatibility patch.');
  }

  const rimrafSources = Object.entries(wordpressSources)
    .filter(([, source]) => /require\( 'rimraf' \)/u.test(source));
  if (
    !sameValues(
      rimrafSources.map(([path]) => path),
      [
        'commands/start.js',
        'download-sources.js',
        'runtime/docker/index.js',
        'runtime/playground/index.js',
      ],
    ) ||
    rimrafSources.some(([, source]) => !/const \{ rimraf \} = require\( 'rimraf' \);/u.test(source)) ||
    /const rimraf = require\( 'rimraf' \);/u.test(allSources)
  ) {
    errors.push('@wordpress/env no longer matches the reviewed rimraf 6 named asynchronous API.');
  }

  const playgroundDependencySources = Object.entries(wordpressSources)
    .filter(([, source]) => /@wp-playground\/|isomorphic-git/u.test(source));
  if (!sameValues(
    playgroundDependencySources.map(([path]) => path),
    ['runtime/playground/index.js'],
  )) {
    errors.push('@wordpress/env no longer isolates Playground dependencies to its inactive Playground runtime.');
  }
  return errors;
}

export function validateRuntimeCompatibility(root = runtimeRoot) {
  const probe = spawnSync(
    process.execPath,
    ['--input-type=commonjs', '--eval', compatibilityProbe],
    { cwd: root, encoding: 'utf8', timeout: 30_000 },
  );
  if (!probe.error && probe.status === 0) return [];
  const detail = probe.error?.message || probe.stderr.trim() || probe.stdout.trim() || `exit status ${probe.status}`;
  return [`WordPress integration runtime compatibility smoke failed: ${detail}`];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const audit = spawnSync(
    'npm',
    ['audit', '--json', '--audit-level=moderate', '--prefix', runtimeRoot],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );

  if (audit.error) {
    throw audit.error;
  }

  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    process.stderr.write(`${audit.stderr || audit.stdout}\n`);
    process.exitCode = 1;
  }

  if (report !== undefined) {
    const lock = JSON.parse(readFileSync(resolve(runtimeRoot, 'package-lock.json'), 'utf8'));
    const wordpressSources = readJavaScriptSources(resolve(runtimeRoot, 'node_modules/@wordpress/env/lib'));
    const integrationRunnerSource = readFileSync(
      resolve(repositoryRoot, 'scripts/run-wordpress-integration.sh'),
      'utf8',
    );
    const integrationWorkflowSource = readFileSync(
      resolve(repositoryRoot, '.github/workflows/wordpress-plugin-ci.yml'),
      'utf8',
    );
    const errors = [
      ...validateRuntimeAudit(report, lock, integrationRunnerSource, integrationWorkflowSource),
      ...validateRuntimeContract(lock, wordpressSources),
      ...validateRuntimeCompatibility(),
    ];
    if ((audit.status === 0 || audit.status === 1) && errors.length === 0) {
      process.stdout.write('WordPress integration runtime audit and applicability contract passed.\n');
    } else {
      process.stderr.write(`${errors.join('\n')}\n`);
      process.exitCode = 1;
    }
  }
}
