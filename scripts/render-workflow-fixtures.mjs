#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { synchronize } from './sync-plugin-standards.mjs';

const output = process.argv[2] ? resolve(process.argv[2]) : null;
if (!output) {
  process.stderr.write('Usage: node scripts/render-workflow-fixtures.mjs OUTPUT_DIRECTORY\n');
  process.exit(2);
}

mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'composer.json'), '{}\n');

const result = synchronize({
  root: output,
  mode: 'apply',
  policyRef: 'a'.repeat(40),
  target: {
    repository: 'stuttter/workflow-fixture',
    enabled: true,
    managed_paths: ['ci', 'release', 'dependabot'],
    manifest: {
      slug: 'workflow-fixture',
      main_file: 'workflow-fixture.php',
      risk: 'standard',
      minimum_php: '7.4',
      minimum_wordpress: '6.7',
      tested_wordpress: '7.1',
      wordpress_org: true,
      multisite: false,
      release_branch: 'main',
      php_matrix: ['7.4', '8.4'],
    },
  },
});

if (result.conflicts.length > 0) {
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}
