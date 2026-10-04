#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = resolve(repositoryRoot, 'runtime/wordpress');
// 4.3.0 moved beyond the advisory range without an identifiable max-stale fix.
// Keep the reviewed uncached-use contract until upstream remediation is confirmed.
const exceptionExpires = Date.parse('2026-11-03T00:00:00Z');
const expectedVersions = {
  '@wordpress/env': '11.15.0',
  got: '11.8.6',
  'cacheable-request': '7.0.4',
  'http-cache-semantics': '4.3.0',
};

function sameValues(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
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

export function validateRuntimeAudit(report) {
  const vulnerabilities = report?.vulnerabilities;
  const counts = report?.metadata?.vulnerabilities;

  if (!vulnerabilities || !counts || !Number.isInteger(counts.total)) {
    return ['npm audit did not return a complete vulnerability report.'];
  }

  const names = Object.keys(vulnerabilities);
  if (counts.total === 0 && names.length === 0) return [];
  return [`npm audit reported vulnerable packages: ${names.join(', ') || 'unknown'}.`];
}

export function validateRuntimeContract(lock, wordpressSources, now = Date.now()) {
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

  if (now >= exceptionExpires) {
    errors.push('The GHSA-ch52-4w7c-c8xp applicability review has expired.');
  }
  return errors;
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
    const errors = [
      ...validateRuntimeAudit(report),
      ...validateRuntimeContract(lock, wordpressSources),
    ];
    if (audit.status === 0 && errors.length === 0) {
      process.stdout.write('WordPress integration runtime audit and applicability contract passed.\n');
    } else {
      process.stderr.write(`${errors.join('\n')}\n`);
      process.exitCode = 1;
    }
  }
}
