#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const smokePath = 'tests/integration/smoke.php';

function isWithin(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith('../');
}

function requireRegularFile(root, path, label) {
  const candidate = resolve(root, path);
  let status;
  try {
    status = lstatSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`${label} is missing at ${path}.`);
    }
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
  const canonical = realpathSync(candidate);
  if (!isWithin(root, canonical)) {
    throw new Error(`${label} must remain inside the repository.`);
  }
  return canonical;
}

export function createWordPressIntegrationConfig(options) {
  const allowedTargets = new Set(['oldest', 'stable', 'trunk']);
  const allowedTopologies = new Set(['single-site', 'multisite']);
  if (!allowedTargets.has(options.target)) {
    throw new Error('WordPress integration target is invalid.');
  }
  if (!allowedTopologies.has(options.topology)) {
    throw new Error('WordPress integration topology is invalid.');
  }
  if (!/^\d+\.\d+$/u.test(options.php)) {
    throw new Error('WordPress integration PHP version is invalid.');
  }
  if (options.target === 'oldest' && !/^\d+\.\d+$/u.test(options.wordpress)) {
    throw new Error('Oldest WordPress integration version is invalid.');
  }
  if (options.target === 'stable' && options.wordpress !== 'latest') {
    throw new Error('Stable WordPress integration must use latest.');
  }
  if (options.target === 'trunk' && options.wordpress !== 'trunk') {
    throw new Error('Trunk WordPress integration must use trunk.');
  }

  const repositoryRoot = realpathSync(options.repositoryRoot);
  const manifestPath = requireRegularFile(repositoryRoot, '.github/plugin-standard.json', 'Plugin manifest');
  const smokeFile = requireRegularFile(repositoryRoot, smokePath, 'Declared integration smoke test');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.slug)) {
    throw new Error('Plugin manifest contains an invalid slug.');
  }

  const pluginStatus = lstatSync(options.pluginDirectory);
  if (!pluginStatus.isDirectory() || pluginStatus.isSymbolicLink()) {
    throw new Error('Built plugin directory is invalid.');
  }
  const pluginDirectory = realpathSync(options.pluginDirectory);
  if (basename(pluginDirectory) !== manifest.slug) {
    throw new Error('Built plugin directory does not match the manifest slug.');
  }

  const core = options.target === 'oldest'
    ? `WordPress/WordPress#${options.wordpress}`
    : options.target === 'trunk'
      ? 'WordPress/WordPress#master'
      : null;

  return {
    slug: manifest.slug,
    config: {
      autoPort: true,
      core,
      phpVersion: options.php,
      plugins: [pluginDirectory],
      multisite: options.topology === 'multisite',
      testsEnvironment: false,
      mappings: {
        'wp-content/portfolio-integration-tests': dirname(smokeFile),
      },
      config: {
        WP_DEBUG: true,
        WP_DEBUG_DISPLAY: false,
        WP_DEBUG_LOG: true,
        SCRIPT_DEBUG: true,
      },
    },
  };
}

function parseArguments(argv) {
  const names = new Set(['--repository-root', '--plugin-directory', '--output', '--target', '--wordpress', '--php', '--topology']);
  const options = {};
  if (argv.length !== names.size * 2) {
    throw new Error('WordPress integration configuration requires every argument exactly once.');
  }
  for (let index = 0; index < argv.length; index += 2) {
    if (!names.has(argv[index]) || !argv[index + 1]) {
      throw new Error('Invalid WordPress integration configuration arguments.');
    }
    const key = argv[index].slice(2).replaceAll('-', '_');
    if (key in options) {
      throw new Error(`WordPress integration configuration repeats ${argv[index]}.`);
    }
    options[key] = argv[index + 1];
  }
  if (Object.keys(options).length !== names.size) {
    throw new Error('WordPress integration configuration requires every argument exactly once.');
  }
  return {
    repositoryRoot: options.repository_root,
    pluginDirectory: options.plugin_directory,
    output: options.output,
    target: options.target,
    wordpress: options.wordpress,
    php: options.php,
    topology: options.topology,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = createWordPressIntegrationConfig(options);
    writeFileSync(options.output, `${JSON.stringify(result.config, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${result.slug}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
