#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeRoot = resolve(repositoryRoot, 'runtime/wordpress');

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
    const errors = validateRuntimeAudit(report);
    if (audit.status === 0 && errors.length === 0) {
      process.stdout.write('WordPress integration runtime audit passed.\n');
    } else {
      process.stderr.write(`${errors.join('\n')}\n`);
      process.exitCode = 1;
    }
  }
}
