#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadInventory } from './sync-plugin-standards.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function selectTargets(inventory, requested = 'all') {
  const targets = inventory.repositories
    .filter((target) => target.enabled && (requested === 'all' || target.repository === requested))
    .map((target) => ({ repository: target.repository, branch: target.manifest.release_branch || 'main' }));

  if (requested !== 'all' && targets.length === 0) {
    throw new Error(`${requested} is not an enabled portfolio target.`);
  }

  return { include: targets };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const inventory = loadInventory(resolve(repositoryRoot, 'portfolio/plugins.json'));
    process.stdout.write(JSON.stringify(selectTargets(inventory, process.argv[2] || 'all')));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
