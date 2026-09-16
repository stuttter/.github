#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCompatibilityBaseline } from './compatibility-policy.mjs';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokePath = 'tests/integration/smoke.php';
const sha256Pattern = /^[a-f0-9]{64}$/u;

export function validateIntegrationPolicy(integration, context = 'integration') {
  const errors = [];

  if (!integration || typeof integration !== 'object' || Array.isArray(integration)) {
    return [`${context} must be an object.`];
  }

  for (const key of Object.keys(integration)) {
    if (!['plugin_check', 'wordpress'].includes(key)) {
      errors.push(`${context} has unsupported key ${key}.`);
    }
  }

  if ('plugin_check' in integration && integration.plugin_check !== true) {
    errors.push(`${context}.plugin_check must be true when declared.`);
  }
  if ('wordpress' in integration) {
    if (!integration.wordpress || typeof integration.wordpress !== 'object' || Array.isArray(integration.wordpress)) {
      errors.push(`${context}.wordpress must be an object when declared.`);
    } else {
      for (const key of Object.keys(integration.wordpress)) {
        if (!['path', 'sha256'].includes(key)) errors.push(`${context}.wordpress has unsupported key ${key}.`);
      }
      if (integration.wordpress.path !== smokePath) errors.push(`${context}.wordpress.path must be ${smokePath}.`);
      if (!sha256Pattern.test(integration.wordpress.sha256 ?? '')) errors.push(`${context}.wordpress.sha256 must be a lowercase SHA-256 digest.`);
    }
  }

  return errors;
}

export function verifyWordPressSmoke(root, contract) {
  const canonicalRoot = realpathSync(root);
  const destination = resolve(canonicalRoot, contract.path);
  const relation = relative(canonicalRoot, destination);
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`)) {
    throw new Error('Centrally enrolled WordPress smoke test escapes the project root.');
  }

  let cursor = canonicalRoot;
  for (const segment of relation.split(sep)) {
    cursor = resolve(cursor, segment);
    let status;
    try {
      status = lstatSync(cursor);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Centrally enrolled WordPress smoke test is missing ${contract.path}.`);
      throw error;
    }
    if (status.isSymbolicLink()) throw new Error(`Centrally enrolled WordPress smoke test requires ${contract.path} to have no symbolic-link components.`);
  }
  if (!lstatSync(destination).isFile()) throw new Error(`Centrally enrolled WordPress smoke test requires ${contract.path} to be a regular file.`);

  const actual = createHash('sha256').update(readFileSync(destination)).digest('hex');
  if (actual !== contract.sha256) throw new Error(`Centrally enrolled WordPress smoke test: ${contract.path} does not match its centrally approved SHA-256.`);
}

export function resolveIntegrationPolicy(inventory, repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('Repository identity is invalid.');
  }
  if (!inventory || !Array.isArray(inventory.repositories)) {
    throw new Error('Portfolio inventory is invalid.');
  }

  const matches = inventory.repositories.filter((item) => item.repository === repository);
  if (matches.length !== 1) {
    throw new Error(`${repository} must have exactly one portfolio entry.`);
  }

  const target = matches[0];
  const errors = [
    ...validateIntegrationPolicy(target.integration, `${repository}.integration`),
    ...validateCompatibilityBaseline(target, repository),
  ];
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  for (const key of ['minimum_php', 'minimum_wordpress']) {
    if (!/^\d+\.\d+$/u.test(target.manifest?.[key] ?? '')) {
      throw new Error(`${repository} has an invalid ${key} value.`);
    }
  }
  if (typeof target.manifest?.multisite !== 'boolean') {
    throw new Error(`${repository} has an invalid multisite value.`);
  }

  const topology = target.manifest.multisite ? 'multisite' : 'single-site';
  const matrix = target.integration.wordpress
    ? {
        include: [
          {
            name: `WordPress ${target.manifest.minimum_wordpress} / PHP ${target.manifest.minimum_php} / ${topology}`,
            target: 'oldest',
            wordpress: target.manifest.minimum_wordpress,
            php: target.manifest.minimum_php,
            topology,
          },
          {
            name: `WordPress stable / PHP 8.4 / ${topology}`,
            target: 'stable',
            wordpress: 'latest',
            php: '8.4',
            topology,
          },
          {
            name: `WordPress trunk / PHP 8.4 / ${topology}`,
            target: 'trunk',
            wordpress: 'trunk',
            php: '8.4',
            topology,
          },
        ],
      }
    : {
        include: [{
          name: 'WordPress integration not declared',
          target: 'disabled',
          wordpress: '',
          php: '',
          topology: 'disabled',
        }],
      };

  return {
    pluginCheck: target.integration.plugin_check === true,
    matrix,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--repository', '--project-root'].includes(argv[index]) || !argv[index + 1]) {
      throw new Error('Usage: integration-check-policy.mjs --repository owner/repository --project-root path');
    }
    options[argv[index].slice(2).replace('-', '_')] = argv[index + 1];
  }
  if (!options.repository || !options.project_root || Object.keys(options).length !== 2) {
    throw new Error('Usage: integration-check-policy.mjs --repository owner/repository --project-root path');
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const inventory = JSON.parse(readFileSync(resolve(scriptRoot, 'portfolio/plugins.json'), 'utf8'));
    const policy = resolveIntegrationPolicy(inventory, options.repository);
    const target = inventory.repositories.find((item) => item.repository === options.repository);
    if (target.integration.wordpress) verifyWordPressSmoke(options.project_root, target.integration.wordpress);
    process.stdout.write(`plugin_check=${policy.pluginCheck ? 'true' : 'false'}\n`);
    process.stdout.write(`matrix=${JSON.stringify(policy.matrix)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
