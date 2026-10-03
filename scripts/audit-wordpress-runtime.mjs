#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = resolve(repositoryRoot, 'runtime/wordpress');
const advisoryUrl = 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp';
const exceptionExpires = Date.parse('2026-11-03T00:00:00Z');
const expectedVersions = {
  '@wordpress/env': '11.15.0',
  got: '11.8.6',
  'cacheable-request': '7.0.4',
  'http-cache-semantics': '4.2.0',
};
const expectedChain = {
  '@wordpress/env': ['got'],
  got: ['cacheable-request'],
  'cacheable-request': ['http-cache-semantics'],
};

function sameValues(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function readJavaScriptSources(directory, root = directory) {
  const sources = {};

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'test' || entry.name === '__tests__') {
      continue;
    }

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(sources, readJavaScriptSources(path, root));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      sources[path.slice(root.length + 1)] = readFileSync(path, 'utf8');
    }
  }

  return sources;
}

export function validateRuntimeAudit(report, lock, wordpressSources, now = Date.now()) {
  const errors = [];
  const vulnerabilities = report?.vulnerabilities;

  if (!vulnerabilities || !report?.metadata?.vulnerabilities) {
    return ['npm audit did not return a complete vulnerability report.'];
  }

  const names = Object.keys(vulnerabilities);
  const allowedNames = [...Object.keys(expectedChain), 'http-cache-semantics'];
  if (!sameValues(names, allowedNames)) {
    errors.push(`Unexpected vulnerable packages: ${names.join(', ') || 'none'}.`);
  }

  for (const [name, expectedVia] of Object.entries(expectedChain)) {
    const vulnerability = vulnerabilities[name];
    const actualVia = vulnerability?.via?.filter((entry) => typeof entry === 'string') ?? [];
    if (!vulnerability || !sameValues(actualVia, expectedVia) || vulnerability.via.length !== expectedVia.length) {
      errors.push(`${name} no longer has the reviewed advisory dependency chain.`);
    }
  }

  const root = vulnerabilities['http-cache-semantics'];
  const rootAdvisories = root?.via?.filter((entry) => typeof entry === 'object') ?? [];
  if (
    !root ||
    root.severity !== 'high' ||
    rootAdvisories.length !== 1 ||
    rootAdvisories[0].url !== advisoryUrl ||
    rootAdvisories[0].range !== '<=4.2.0'
  ) {
    errors.push('http-cache-semantics does not match the reviewed GHSA-ch52-4w7c-c8xp finding.');
  }

  const counts = report.metadata.vulnerabilities;
  if (counts.total !== 4 || counts.high !== 4 || counts.critical !== 0 || counts.moderate !== 0) {
    errors.push('The audit contains findings outside the single reviewed high-severity advisory chain.');
  }

  for (const [name, version] of Object.entries(expectedVersions)) {
    if (lock?.packages?.[`node_modules/${name}`]?.version !== version) {
      errors.push(`${name} is not locked to the reviewed ${version} version.`);
    }
  }

  const gotSources = Object.entries(wordpressSources).filter(([, source]) => /\bgot\b/u.test(source));
  const expectedGotSources = ['download-sources.js', 'wordpress.js'];
  const wordpressSource = wordpressSources['wordpress.js'] ?? '';
  const downloadSource = wordpressSources['download-sources.js'] ?? '';
  const allSources = Object.values(wordpressSources).join('\n');
  if (
    !sameValues(gotSources.map(([path]) => path), expectedGotSources) ||
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

  if (report) {
    const counts = report?.metadata?.vulnerabilities;
    if (audit.status === 0 && counts?.total === 0) {
      process.stdout.write('WordPress integration runtime audit passed.\n');
    } else {
      const lock = JSON.parse(readFileSync(resolve(runtimeRoot, 'package-lock.json'), 'utf8'));
      const wordpressSources = readJavaScriptSources(
        resolve(runtimeRoot, 'node_modules/@wordpress/env/lib'),
      );
      const errors = validateRuntimeAudit(report, lock, wordpressSources);
      if (errors.length) {
        process.stderr.write(`${errors.join('\n')}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(
          'GHSA-ch52-4w7c-c8xp is confined to the reviewed, uncached @wordpress/env request paths.\n',
        );
      }
    }
  }
}
