#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectOrganizationCredentials,
  redactCredentials,
  runGitHub,
  selectReleaseTargets,
} from './provision-release-environments.mjs';
import { loadInventory } from './sync-plugin-standards.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function auditWordPressOrgSecretAccess({ inventory, execute = runGitHub }) {
  const expectedRepositories = selectReleaseTargets(inventory).map((target) => target.repository);
  const inspection = inspectOrganizationCredentials({
    approvedRepositories: expectedRepositories,
    execute,
  });

  return {
    status: inspection.errors.length === 0 ? 'clean' : 'drift',
    ...inspection,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) {
      throw new Error('Usage: npm run release:credential-access:audit');
    }

    const inventory = loadInventory(resolve(repositoryRoot, 'portfolio/plugins.json'));
    const report = auditWordPressOrgSecretAccess({ inventory });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.errors.length > 0) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${redactCredentials(error.message)}\n`);
    process.exitCode = 2;
  }
}
