#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInventory } from './sync-plugin-standards.mjs';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function comparableManifest(manifest) {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== '$schema').sort(([left], [right]) => left.localeCompare(right)));
}

export function verifyManifestPolicy(inventory, repository, projectRoot) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('Repository identity is invalid.');
  const matches = inventory.repositories.filter((item) => item.repository === repository && item.enabled === true);
  if (matches.length !== 1) throw new Error(`${repository} must have exactly one enabled portfolio entry.`);

  const manifestPath = resolve(projectRoot, '.github/plugin-standard.json');
  if (!lstatSync(manifestPath).isFile()) throw new Error('Plugin manifest must be a regular file.');
  const local = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expected = comparableManifest(matches[0].manifest);
  const actual = comparableManifest(local);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Plugin manifest differs from the immutable portfolio inventory.');
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--repository', '--project-root'].includes(argv[index]) || !argv[index + 1]) throw new Error('Usage: verify-manifest-policy.mjs --repository owner/repository --project-root path');
    options[argv[index].slice(2).replace('-', '_')] = argv[index + 1];
  }
  if (!options.repository || !options.project_root || Object.keys(options).length !== 2) throw new Error('Usage: verify-manifest-policy.mjs --repository owner/repository --project-root path');
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const inventory = loadInventory(resolve(scriptRoot, 'portfolio/plugins.json'));
    verifyManifestPolicy(inventory, options.repository, resolve(options.project_root));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
