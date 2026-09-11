#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const managedMarker = '# Managed by stuttter/.github fleet standards. Do not edit locally.';
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isUriReference(value) {
  if (typeof value !== 'string') return false;
  try {
    new URL(value, 'https://schema.invalid/');
    return true;
  } catch {
    return false;
  }
}

export function validateManifest(manifest, context = 'manifest') {
  const required = ['slug', 'main_file', 'risk', 'minimum_php', 'minimum_wordpress', 'tested_wordpress', 'wordpress_org', 'multisite'];
  const optional = ['$schema', 'release_branch', 'php_matrix'];
  const errors = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [`${context} must be an object.`];
  }

  for (const key of required) {
    if (!(key in manifest)) errors.push(`${context} is missing ${key}.`);
  }
  for (const key of Object.keys(manifest)) {
    if (![...required, ...optional].includes(key)) errors.push(`${context} has unsupported key ${key}.`);
  }
  if (typeof manifest.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.slug)) errors.push(`${context} slug is invalid.`);
  if ('$schema' in manifest && !isUriReference(manifest.$schema)) errors.push(`${context} $schema must be a URI reference.`);
  if (typeof manifest.main_file !== 'string' || !/^[^/]+\.php$/.test(manifest.main_file)) errors.push(`${context} main_file is invalid.`);
  if (!['standard', 'elevated', 'critical'].includes(manifest.risk)) errors.push(`${context} risk is invalid.`);
  for (const key of ['minimum_php', 'minimum_wordpress', 'tested_wordpress']) {
    if (typeof manifest[key] !== 'string' || !/^\d+\.\d+$/.test(manifest[key])) errors.push(`${context} ${key} is invalid.`);
  }
  for (const key of ['wordpress_org', 'multisite']) {
    if (typeof manifest[key] !== 'boolean') errors.push(`${context} ${key} must be boolean.`);
  }
  if ('release_branch' in manifest && (typeof manifest.release_branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(manifest.release_branch))) errors.push(`${context} release_branch is invalid.`);
  if ('php_matrix' in manifest) {
    if (!Array.isArray(manifest.php_matrix) || manifest.php_matrix.length === 0 || new Set(manifest.php_matrix).size !== manifest.php_matrix.length || manifest.php_matrix.some((version) => typeof version !== 'string' || !/^\d+\.\d+$/.test(version))) {
      errors.push(`${context} php_matrix is invalid.`);
    } else {
      const sorted = [...manifest.php_matrix].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      if (!manifest.php_matrix.includes(manifest.minimum_php)) errors.push(`${context} php_matrix must include minimum_php.`);
      if (manifest.php_matrix[0] !== manifest.minimum_php) errors.push(`${context} php_matrix must begin with minimum_php.`);
      if (JSON.stringify(sorted) !== JSON.stringify(manifest.php_matrix)) errors.push(`${context} php_matrix must be ordered from oldest to newest.`);
    }
  }
  return errors;
}

export function loadInventory(path) {
  const inventory = JSON.parse(readFileSync(path, 'utf8'));
  const errors = [];
  const allowedRoot = new Set(['$schema', 'repositories']);

  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) throw new Error('Portfolio inventory must be an object.');
  for (const key of Object.keys(inventory)) if (!allowedRoot.has(key)) errors.push(`Inventory has unsupported key ${key}.`);
  if ('$schema' in inventory && !isUriReference(inventory.$schema)) errors.push('Inventory $schema must be a URI reference.');
  if (!Array.isArray(inventory.repositories)) errors.push('Inventory repositories must be an array.');

  const seen = new Set();
  for (const [index, item] of (inventory.repositories || []).entries()) {
    const context = `repositories[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${context} must be an object.`);
      continue;
    }
    for (const key of Object.keys(item)) if (!['repository', 'enabled', 'managed_paths', 'manifest'].includes(key)) errors.push(`${context} has unsupported key ${key}.`);
    if (typeof item.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repository)) errors.push(`${context} repository is invalid.`);
    const repositoryIdentity = typeof item.repository === 'string' ? item.repository.toLowerCase() : item.repository;
    if (seen.has(repositoryIdentity)) errors.push(`${context} duplicates ${item.repository}.`);
    seen.add(repositoryIdentity);
    if (typeof item.enabled !== 'boolean') errors.push(`${context} enabled must be boolean.`);
    const managedPaths = ['ci', 'release', 'dependabot'];
    if (!Array.isArray(item.managed_paths) || new Set(item.managed_paths).size !== item.managed_paths.length || item.managed_paths.some((path) => !managedPaths.includes(path))) {
      errors.push(`${context} managed_paths is invalid.`);
    }
    if (item.managed_paths?.includes('release') && item.manifest?.wordpress_org !== true) errors.push(`${context} cannot manage a WordPress.org release caller when wordpress_org is false.`);
    errors.push(...validateManifest(item.manifest, `${context}.manifest`));
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return inventory;
}

function render(template, values) {
  return template.replace(/{{([a-z_]+)}}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`Template variable ${key} is not defined.`);
    return values[key];
  });
}

function comparableManifest(manifest) {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== '$schema').sort(([left], [right]) => left.localeCompare(right)));
}

function safeManagedPath(root, relativePath) {
  const canonicalRoot = realpathSync(root);
  const path = resolve(canonicalRoot, relativePath);
  const fromRoot = relative(canonicalRoot, path);

  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    return { path, reason: 'managed path resolves outside the repository root' };
  }

  let current = canonicalRoot;
  for (const component of fromRoot.split(/[\\/]/)) {
    current = join(current, component);
    try {
      const status = lstatSync(current);
      if (status.isSymbolicLink()) {
        return { path, reason: `managed path contains symbolic link: ${relative(canonicalRoot, current)}` };
      }
      if (current !== path && !status.isDirectory()) {
        return { path, reason: `managed path parent is not a directory: ${relative(canonicalRoot, current)}` };
      }
      if (current === path && !status.isFile()) {
        return { path, reason: 'managed path exists but is not a regular file' };
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }

  return { path, reason: null };
}

function writeManagedFile(root, relativePath, desired) {
  const initial = safeManagedPath(root, relativePath);
  if (initial.reason) throw new Error(`${relativePath}: ${initial.reason}.`);

  const parent = dirname(initial.path);
  mkdirSync(parent, { recursive: true });

  const verified = safeManagedPath(root, relativePath);
  if (verified.reason) {
    throw new Error(`${relativePath}: ${verified.reason}.`);
  }

  const temporaryDirectory = mkdtempSync(join(parent, '.fleet-sync-'));
  const temporaryPath = join(temporaryDirectory, 'managed-file');
  try {
    writeFileSync(temporaryPath, desired, { flag: 'wx' });
    renameSync(temporaryPath, verified.path);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function desiredFiles(root, target, policyRef) {
  const { manifest } = target;
  const releaseBranch = manifest.release_branch || 'main';
  const phpMatrix = manifest.php_matrix || [manifest.minimum_php];
  const values = {
    policy_ref: policyRef,
    release_branch: releaseBranch,
    php_matrix_json: JSON.stringify(phpMatrix),
    quality_php_version: [...phpMatrix].sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).at(-1),
  };
  const template = (name) => readFileSync(resolve(scriptRoot, 'fleet/templates', name), 'utf8');
  const files = new Map([
    ['.github/plugin-standard.json', `${JSON.stringify({ $schema: 'https://raw.githubusercontent.com/stuttter/.github/main/schema/plugin-standard.schema.json', ...manifest }, null, 2)}\n`],
  ]);
  const managed = new Set(target.managed_paths);
  if (managed.has('ci')) files.set('.github/workflows/ci.yml', render(template('ci.yml'), values));
  if (managed.has('release')) files.set('.github/workflows/release.yml', render(template('release.yml'), values));
  if (managed.has('dependabot')) files.set('.github/dependabot.yml', template(existsSync(resolve(root, 'composer.json')) ? 'dependabot-composer.yml' : 'dependabot.yml'));
  return files;
}

export function synchronize({ root, target, policyRef, mode = 'audit' }) {
  if (!['audit', 'apply'].includes(mode)) throw new Error(`Unsupported mode: ${mode}.`);
  if (typeof policyRef !== 'string' || !/^[0-9a-f]{40}$/.test(policyRef)) throw new Error('policyRef must be the full commit SHA of the fleet policy checkout.');
  const changes = [];
  const conflicts = [];
  const writes = [];

  for (const [relativePath, desired] of desiredFiles(root, target, policyRef)) {
    const safety = safeManagedPath(root, relativePath);
    const { path } = safety;
    if (safety.reason) {
      conflicts.push({ path: relativePath, reason: safety.reason });
      continue;
    }
    if (!existsSync(path)) {
      changes.push({ path: relativePath, action: 'add' });
      writes.push({ relativePath, desired });
      continue;
    }

    const current = readFileSync(path, 'utf8');
    if (relativePath === '.github/plugin-standard.json') {
      let actual;
      try {
        actual = JSON.parse(current);
      } catch (error) {
        conflicts.push({ path: relativePath, reason: `invalid JSON: ${error.message}` });
        continue;
      }
      const errors = validateManifest(actual, relativePath);
      if (errors.length) {
        conflicts.push({ path: relativePath, reason: errors.join(' ') });
      } else if (JSON.stringify(comparableManifest(actual)) !== JSON.stringify(comparableManifest(target.manifest))) {
        conflicts.push({ path: relativePath, reason: 'repository manifest differs from the portfolio inventory; reconcile it deliberately' });
      }
      continue;
    }

    if (current === desired) continue;
    if (!current.startsWith(`${managedMarker}\n`)) {
      conflicts.push({ path: relativePath, reason: 'existing repository-owned file has no fleet-managed marker' });
      continue;
    }
    changes.push({ path: relativePath, action: 'update' });
    writes.push({ relativePath, desired });
  }

  if (mode === 'apply' && conflicts.length === 0) {
    for (const { relativePath, desired } of writes) {
      writeManagedFile(root, relativePath, desired);
    }
  }

  return { repository: target.repository, mode, changes, conflicts, clean: changes.length === 0 && conflicts.length === 0 };
}

function parseArguments(argv) {
  const options = { mode: 'audit', inventory: resolve(scriptRoot, 'portfolio/plugins.json') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--mode', '--inventory', '--repository', '--repo-dir', '--policy-ref'].includes(argument)) throw new Error(`Unknown argument: ${argument}.`);
    if (!argv[index + 1]) throw new Error(`${argument} requires a value.`);
    options[argument.slice(2).replace('-', '_')] = argv[index + 1];
    index += 1;
  }
  if (!options.repository || !options.repo_dir || !options.policy_ref) throw new Error('--repository, --repo-dir, and --policy-ref are required.');
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const inventory = loadInventory(resolve(options.inventory));
    const target = inventory.repositories.find((item) => item.repository === options.repository && item.enabled);
    if (!target) throw new Error(`${options.repository} is not an enabled portfolio target.`);
    const result = synchronize({ root: resolve(options.repo_dir), target, policyRef: options.policy_ref, mode: options.mode });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.conflicts.length ? 2 : options.mode === 'audit' && result.changes.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
