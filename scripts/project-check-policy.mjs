#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCompatibilityBaseline } from './compatibility-policy.mjs';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedNodeVersions = new Set(['22', '24']);
const supportedNodeScripts = new Set(['build:check']);
const dormantPhpcsContractPaths = new Set([
  '.phpcs.xml',
  '.phpcs.xml.dist',
  'phpcs.xml',
  'phpcs.xml.dist',
  'scripts/check-phpcs-baseline.php',
]);
const safeContractPath = /^(?:composer\.(?:json|lock)|package(?:-lock)?\.json|phpunit\.xml\.dist|\.?phpcs\.xml(?:\.dist)?|(?:bin|scripts|tests)\/[A-Za-z0-9._/-]+)$/u;
const safeNodeContractPath = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const safeSmokePath = /^(?:bin|tests)\/[A-Za-z0-9._/-]+\.sh$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function safePath(path, pattern) {
  return typeof path === 'string'
    && !path.includes('\r')
    && !path.includes('\n')
    && pattern.test(path)
    && !path.includes('//')
    && !path.split('/').includes('.')
    && !path.split('/').includes('..');
}

function validateFiles(files, context, pathPattern = safeContractPath) {
  const errors = [];
  if (!Array.isArray(files) || files.length === 0) return [`${context} must be a non-empty array.`];
  const seen = new Set();
  for (const [index, file] of files.entries()) {
    const item = `${context}[${index}]`;
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      errors.push(`${item} must be an object.`);
      continue;
    }
    for (const key of Object.keys(file)) if (!['path', 'sha256'].includes(key)) errors.push(`${item} has unsupported key ${key}.`);
    if (!safePath(file.path, pathPattern)) errors.push(`${item}.path is unsafe.`);
    if (typeof file.path === 'string' && seen.has(file.path)) errors.push(`${context} repeats ${file.path}.`);
    if (typeof file.path === 'string') seen.add(file.path);
    if (!sha256Pattern.test(file.sha256 ?? '')) errors.push(`${item}.sha256 must be a lowercase SHA-256 digest.`);
  }
  return errors;
}

function parseNodeCommand(command, aliases, context) {
  const errors = [];
  const paths = [];
  if (typeof command !== 'string' || command === '' || command !== command.trim() || /[\t\r\n`'"\\$()<>|;*?\[\]{}!]/u.test(command)) {
    return { errors: [`${context} uses unsupported shell syntax.`], paths };
  }

  const tokens = command.split(/ +/u);
  const segments = [];
  let segment = [];
  for (const token of tokens) {
    if (token === '&&') {
      if (segment.length === 0) return { errors: [`${context} has an invalid && command boundary.`], paths };
      segments.push(segment);
      segment = [];
    } else if (token.includes('&')) {
      return { errors: [`${context} uses unsupported shell syntax.`], paths };
    } else {
      segment.push(token);
    }
  }
  if (segment.length === 0) return { errors: [`${context} has an invalid && command boundary.`], paths };
  segments.push(segment);

  for (const words of segments) {
    const executable = words[0];
    if ((executable === 'npm') && words.length === 3 && ['run', 'run-script'].includes(words[1]) && /^[A-Za-z0-9:_-]+$/u.test(words[2])) {
      if (!aliases.has(words[2])) errors.push(`${context} invokes undeclared npm alias ${words[2]}.`);
    } else if (executable === 'node' && words.length === 2 && safePath(words[1], /^(?:bin|scripts|tests)\/[A-Za-z0-9._/-]+$/u)) {
      paths.push(words[1]);
    } else if (executable === 'postcss' && words.length === 8 && words[2] === '--output' && words[4] === '--env' && /^(?:dev|prod)$/u.test(words[5]) && words[6] === '--config') {
      const config = `${words[7]}/postcss.config.js`;
      for (const path of [words[1], words[3], config]) {
        if (!safePath(path, safeNodeContractPath)) errors.push(`${context} has an unsafe PostCSS path.`);
        else paths.push(path);
      }
    } else if (executable === 'git' && words.length >= 5 && words[1] === 'diff' && words[2] === '--exit-code' && words[3] === '--') {
      for (const path of words.slice(4)) {
        if (!safePath(path, safeNodeContractPath)) errors.push(`${context} has an unsafe git diff path.`);
        else paths.push(path);
      }
    } else {
      errors.push(`${context} uses unapproved executable or command form ${executable}.`);
    }
  }
  return { errors, paths };
}

export function validateProjectChecks(checks, context = 'checks', multisite = false) {
  const errors = [];
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return [`${context} must be an object.`];
  for (const key of Object.keys(checks)) if (!['phpunit', 'node', 'smoke'].includes(key)) errors.push(`${context} has unsupported key ${key}.`);

  if (!('phpunit' in checks)) {
    errors.push(`${context} must explicitly declare phpunit.`);
  } else if (checks.phpunit !== false) {
    if (!checks.phpunit || typeof checks.phpunit !== 'object' || Array.isArray(checks.phpunit)) {
      errors.push(`${context}.phpunit must be false or an object.`);
    } else {
      for (const key of Object.keys(checks.phpunit)) if (!['config', 'files'].includes(key)) errors.push(`${context}.phpunit has unsupported key ${key}.`);
      if (checks.phpunit.config !== 'phpunit.xml.dist') errors.push(`${context}.phpunit.config must be phpunit.xml.dist.`);
      errors.push(...validateFiles(checks.phpunit.files, `${context}.phpunit.files`));
      const paths = Array.isArray(checks.phpunit.files) ? checks.phpunit.files.map((file) => file?.path) : [];
      for (const manifest of ['composer.json', 'composer.lock']) if (!paths.includes(manifest)) errors.push(`${context}.phpunit.files must hash ${manifest}.`);
      if (!paths.includes(checks.phpunit.config)) errors.push(`${context}.phpunit.files must hash the PHPUnit configuration.`);
      if (!paths.some((path) => typeof path === 'string' && path.startsWith('tests/') && path.endsWith('.php'))) errors.push(`${context}.phpunit.files must hash a tests/ bootstrap or runner.`);
      for (const path of paths) {
        if (dormantPhpcsContractPaths.has(path)) errors.push(`${context}.phpunit.files may not bind dormant repository-local PHPCS tooling ${path}.`);
      }
    }
  }

  if ('node' in checks) {
    if (!checks.node || typeof checks.node !== 'object' || Array.isArray(checks.node)) {
      errors.push(`${context}.node must be an object.`);
    } else {
      for (const key of Object.keys(checks.node)) if (!['version', 'script', 'scripts', 'files'].includes(key)) errors.push(`${context}.node has unsupported key ${key}.`);
      if (!supportedNodeVersions.has(checks.node.version)) errors.push(`${context}.node.version is unsupported.`);
      if (!supportedNodeScripts.has(checks.node.script)) errors.push(`${context}.node.script is unsupported.`);
      if (!checks.node.scripts || typeof checks.node.scripts !== 'object' || Array.isArray(checks.node.scripts)) {
        errors.push(`${context}.node.scripts must be an object.`);
      } else {
        if (!(checks.node.script in checks.node.scripts)) errors.push(`${context}.node.scripts must declare the entry script.`);
        const aliases = new Set(Object.keys(checks.node.scripts));
        for (const [name, command] of Object.entries(checks.node.scripts)) {
          if (!/^[A-Za-z0-9:_-]+$/u.test(name) || typeof command !== 'string' || command.trim() === '') {
            errors.push(`${context}.node.scripts.${name} must be a non-empty fixed command.`);
            continue;
          }
          const parsed = parseNodeCommand(command, aliases, `${context}.node.scripts.${name}`);
          errors.push(...parsed.errors);
        }
      }
      errors.push(...validateFiles(checks.node.files, `${context}.node.files`, safeNodeContractPath));
      const paths = Array.isArray(checks.node.files) ? checks.node.files.map((file) => file?.path) : [];
      for (const manifest of ['package.json', 'package-lock.json']) if (!paths.includes(manifest)) errors.push(`${context}.node.files must hash ${manifest}.`);
      const aliases = new Set(Object.keys(checks.node.scripts ?? {}));
      for (const [name, command] of Object.entries(checks.node.scripts ?? {})) {
        if (typeof command !== 'string') continue;
        const parsed = parseNodeCommand(command, aliases, `${context}.node.scripts.${name}`);
        for (const path of parsed.paths) if (!paths.includes(path)) errors.push(`${context}.node.files must hash command path ${path}.`);
      }
    }
  }

  if ('smoke' in checks) {
    if (!checks.smoke || typeof checks.smoke !== 'object' || Array.isArray(checks.smoke)) {
      errors.push(`${context}.smoke must be an object.`);
    } else {
      for (const key of Object.keys(checks.smoke)) if (!['single_site', 'multisite', 'payloads', 'files'].includes(key)) errors.push(`${context}.smoke has unsupported key ${key}.`);
      if (!('single_site' in checks.smoke) && !('multisite' in checks.smoke)) errors.push(`${context}.smoke must declare at least one smoke script.`);
      for (const mode of ['single_site', 'multisite']) {
        const path = checks.smoke[mode];
        if (path !== undefined && !safePath(path, safeSmokePath)) errors.push(`${context}.smoke.${mode} must be a safe bin/ or tests/ shell-script path without line breaks.`);
      }
      errors.push(...validateFiles(checks.smoke.files, `${context}.smoke.files`));
      const paths = Array.isArray(checks.smoke.files) ? checks.smoke.files.map((file) => file?.path) : [];
      for (const mode of ['single_site', 'multisite']) {
        if (!checks.smoke[mode]) continue;
        if (!paths.includes(checks.smoke[mode])) errors.push(`${context}.smoke.files must hash ${checks.smoke[mode]}.`);
        const payload = checks.smoke.payloads?.[mode];
        if (!safePath(payload, safeContractPath) || !payload.endsWith('.php')) errors.push(`${context}.smoke.payloads.${mode} must be a safe PHP payload path without line breaks.`);
        else if (!paths.includes(payload)) errors.push(`${context}.smoke.files must hash ${payload}.`);
      }
      if (!checks.smoke.payloads || typeof checks.smoke.payloads !== 'object' || Array.isArray(checks.smoke.payloads)) {
        errors.push(`${context}.smoke.payloads must be an object.`);
      } else {
        for (const key of Object.keys(checks.smoke.payloads)) if (!['single_site', 'multisite'].includes(key)) errors.push(`${context}.smoke.payloads has unsupported key ${key}.`);
      }
      if ('multisite' in checks.smoke && !multisite) errors.push(`${context}.smoke.multisite requires manifest.multisite to be true.`);
    }
  }
  return errors;
}

function regularContainedFile(root, path, context) {
  const canonicalRoot = realpathSync(root);
  const destination = resolve(canonicalRoot, path);
  const relation = relative(canonicalRoot, destination);
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`)) throw new Error(`${context}: ${path} escapes the project root.`);
  let cursor = canonicalRoot;
  for (const segment of relation.split(sep)) {
    cursor = resolve(cursor, segment);
    let status;
    try {
      status = lstatSync(cursor);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`${context} is missing ${path}.`);
      throw error;
    }
    if (status.isSymbolicLink()) throw new Error(`${context} requires ${path} to have no symbolic-link components.`);
  }
  if (!lstatSync(destination).isFile()) throw new Error(`${context} requires ${path} to be a regular file.`);
  return destination;
}

export function verifyFileContracts(root, files, context) {
  for (const file of files) {
    const source = readFileSync(regularContainedFile(root, file.path, context));
    const actual = createHash('sha256').update(source).digest('hex');
    if (actual !== file.sha256) throw new Error(`${context}: ${file.path} does not match its centrally approved SHA-256.`);
  }
}

function parseJsonFile(path, context) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${context} is invalid JSON: ${error.message}`);
  }
}

export function validatePhpunitProject(root, contract) {
  const composerPath = regularContainedFile(root, 'composer.json', 'Centrally enrolled PHPUnit');
  const lockPath = regularContainedFile(root, 'composer.lock', 'Centrally enrolled PHPUnit');
  const lock = parseJsonFile(lockPath, 'Centrally enrolled PHPUnit composer.lock');
  const packages = [...(Array.isArray(lock.packages) ? lock.packages : []), ...(Array.isArray(lock['packages-dev']) ? lock['packages-dev'] : [])];
  if (packages.filter((item) => item?.name === 'phpunit/phpunit').length !== 1) throw new Error('Centrally enrolled PHPUnit requires exactly one locked phpunit/phpunit package.');
  parseJsonFile(composerPath, 'Centrally enrolled PHPUnit composer.json');
  verifyFileContracts(root, contract.files, 'Centrally enrolled PHPUnit');
}

export function validateInstalledPhpunit(root) {
  const binary = regularContainedFile(root, 'vendor/bin/phpunit', 'Centrally enrolled PHPUnit');
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    throw new Error('Centrally enrolled PHPUnit requires an executable locked vendor/bin/phpunit binary.');
  }
}

export function validateNodeProject(root, contract) {
  const packagePath = regularContainedFile(root, 'package.json', 'Centrally enrolled Node check');
  regularContainedFile(root, 'package-lock.json', 'Centrally enrolled Node check');
  const packageJson = parseJsonFile(packagePath, 'Centrally enrolled Node package.json');
  const actualScripts = packageJson?.scripts;
  if (!actualScripts || typeof actualScripts !== 'object' || Array.isArray(actualScripts)) throw new Error('Centrally enrolled Node check requires a package scripts object.');
  const expectedNames = Object.keys(contract.scripts).sort();
  const actualNames = Object.keys(actualScripts).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('Centrally enrolled Node check requires the exact approved package script names.');
  for (const [name, command] of Object.entries(contract.scripts)) {
    if (actualScripts[name] !== command) throw new Error(`Centrally enrolled Node check requires scripts.${name} to match its approved command.`);
  }
  verifyFileContracts(root, contract.files, 'Centrally enrolled Node check');
}

export function validateSmokeProject(root, contract) {
  verifyFileContracts(root, contract.files, 'Centrally enrolled smoke check');
}

export function validateProjectFiles(root, checks) {
  if (checks.phpunit !== false) validatePhpunitProject(root, checks.phpunit);
  if (checks.node) validateNodeProject(root, checks.node);
  if (checks.smoke) validateSmokeProject(root, checks.smoke);
}

export function resolveProjectCheckPolicy(inventory, repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('Repository identity is invalid.');
  if (!inventory || !Array.isArray(inventory.repositories)) throw new Error('Portfolio inventory is invalid.');
  const matches = inventory.repositories.filter((item) => item.repository === repository);
  if (matches.length !== 1) throw new Error(`${repository} must have exactly one portfolio entry.`);
  const target = matches[0];
  const errors = [
    ...validateProjectChecks(target.checks, `${repository}.checks`, target.manifest?.multisite === true),
    ...validateCompatibilityBaseline(target, repository),
  ];
  if (errors.length > 0) throw new Error(errors.join('\n'));
  if (!/^\d+\.\d+$/u.test(target.manifest?.minimum_php ?? '')) throw new Error(`${repository} has an invalid minimum PHP version.`);

  const checks = target.checks;
  const include = [];
  if (checks.phpunit !== false) include.push({ name: `Minimum PHP ${target.manifest.minimum_php} tests`, kind: 'minimum-php', php: target.manifest.minimum_php, node: '', script: '', config: checks.phpunit.config });
  if (checks.node) include.push({ name: `Node ${checks.node.version} generated assets`, kind: 'node-assets', php: '', node: checks.node.version, script: checks.node.script, config: '' });
  for (const [mode, label] of [['single_site', 'Single-site smoke'], ['multisite', 'Multisite smoke']]) if (checks.smoke?.[mode]) include.push({ name: label, kind: 'live-smoke', php: '', node: '', script: checks.smoke[mode], config: '' });
  if (include.length === 0) include.push({ name: 'No enrolled project-specific checks', kind: 'none', php: '', node: '', script: '', config: '' });
  return { matrix: { include }, node: checks.node ?? null, phpunit: checks.phpunit === false ? null : checks.phpunit };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--repository', '--project-root', '--mode'].includes(argv[index]) || !argv[index + 1]) throw new Error('Usage: project-check-policy.mjs --repository owner/repository --project-root path [--mode outputs|verify|verify-installed]');
    options[argv[index].slice(2).replace('-', '_')] = argv[index + 1];
  }
  if (!options.repository || !options.project_root) throw new Error('Usage: project-check-policy.mjs --repository owner/repository --project-root path [--mode outputs|verify|verify-installed]');
  if (options.mode && !['outputs', 'verify', 'verify-installed'].includes(options.mode)) throw new Error('--mode must be outputs, verify, or verify-installed.');
  return options;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const inventory = JSON.parse(readFileSync(resolve(scriptRoot, 'portfolio/plugins.json'), 'utf8'));
    const policy = resolveProjectCheckPolicy(inventory, options.repository);
    const target = inventory.repositories.find((item) => item.repository === options.repository);
    validateProjectFiles(options.project_root, target.checks);
    if (options.mode === 'verify-installed' && target.checks.phpunit !== false) validateInstalledPhpunit(options.project_root);
    if ((options.mode ?? 'outputs') === 'outputs') {
      process.stdout.write(`matrix=${JSON.stringify(policy.matrix)}\n`);
      process.stdout.write(`node_enabled=${policy.node ? 'true' : 'false'}\n`);
      process.stdout.write(`node_version=${policy.node?.version ?? ''}\n`);
      process.stdout.write(`node_script=${policy.node?.script ?? ''}\n`);
      process.stdout.write(`phpunit_enabled=${policy.phpunit ? 'true' : 'false'}\n`);
      process.stdout.write(`phpunit_config=${policy.phpunit?.config ?? ''}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
