#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInventory } from './sync-plugin-standards.mjs';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function comparableManifest(manifest) {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== '$schema').sort(([left], [right]) => left.localeCompare(right)));
}

const directPublisherAction = /[A-Za-z0-9_.-]+\/action-wordpress-plugin-(?:asset-update|deploy)@/iu;
const svnWriteCommands = new Set(['ci', 'commit', 'copy', 'cp', 'dcommit', 'delete', 'del', 'import', 'lock', 'mkdir', 'move', 'mv', 'pd', 'pdel', 'pe', 'pedit', 'propdel', 'propedit', 'propset', 'ps', 'pset', 'remove', 'ren', 'rename', 'rm', 'unlock']);
const svnOptionsWithValues = new Set([
  '--accept',
  '--changelist',
  '--cl',
  '--config-dir',
  '--config-option',
  '--depth',
  '--diff-cmd',
  '--editor-cmd',
  '--extensions',
  '--file',
  '--limit',
  '--message',
  '--native-eol',
  '--password',
  '--revision',
  '--targets',
  '--trust-server-cert-failures',
  '--username',
  '--with-revprop',
  '-F',
  '-l',
  '-m',
  '-r',
  '-x',
]);

function shellSegments(command) {
  const normalized = command
    .replace(/\$\(\s*command\s+-v\s+(?:svn|svnmucc)\s*\)/giu, (match) => match.toLowerCase().includes('svnmucc') ? 'svnmucc' : 'svn')
    .replace(/`\s*command\s+-v\s+(?:svn|svnmucc)\s*`/giu, (match) => match.toLowerCase().includes('svnmucc') ? 'svnmucc' : 'svn');
  const segments = [];
  let current = '';
  let quote = '';
  let substitutionDepth = 0;

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const next = normalized[index + 1];
    if (character === '\\') {
      current += character;
      if (next !== undefined) current += normalized[index += 1];
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '$' && next === '(') {
      substitutionDepth += 1;
      current += '$(';
      index += 1;
      continue;
    }
    if (character === ')' && substitutionDepth > 0) {
      substitutionDepth -= 1;
      current += character;
      continue;
    }
    if (substitutionDepth === 0 && (character === '\n' || character === ';' || character === '|' || (character === '&' && next === '&'))) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if ((character === '|' || character === '&') && next === character) index += 1;
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellTokens(command) {
  return command
    .match(/(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+)/gu)
    ?.map((token) => token.replace(/^[({]+|[),}]+$/gu, '').replace(/^["']|["']$/gu, ''))
    .filter(Boolean) ?? [];
}

function executableName(token) {
  return basename(token.replace(/^["']|["']$/gu, '')).toLowerCase();
}

function containsDirectPublisher(command) {
  for (const segment of shellSegments(command)) {
    const tokens = shellTokens(segment);
    if (tokens.some((token) => executableName(token) === 'svnmucc')) return true;
    for (let index = 0; index < tokens.length; index += 1) {
      if (executableName(tokens[index]) !== 'svn') continue;
      index += 1;
      while (index < tokens.length && tokens[index].startsWith('-')) {
        const option = tokens[index];
        const optionName = option.includes('=') ? option.slice(0, option.indexOf('=')) : option;
        index += svnOptionsWithValues.has(optionName) && !option.includes('=') ? 2 : 1;
      }
      if (svnWriteCommands.has(tokens[index]?.toLowerCase())) return true;
    }
  }
  return false;
}

function workflowCommands(definition) {
  const lines = definition.split(/\r?\n/u);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([\t ]*)(?:-\s+)?run:\s*(.*)$/u.exec(lines[index]);
    if (!match) continue;

    const baseIndent = lines[index].indexOf('run:');
    if (/^\*[A-Za-z0-9_-]+(?:\s+#.*)?$/u.test(match[2].trim())) {
      throw new Error('Workflow run aliases are unsupported by the direct-publisher policy.');
    }
    const scalar = /^([>|])(?:[-+]\d*)?\s*(?:#.*)?$/u.exec(match[2].trim());
    const parts = scalar ? [] : [match[2].trim()];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      const indent = /^[\t ]*/u.exec(next)[0].length;
      if (next.trim() && indent <= baseIndent) break;
      index += 1;
      parts.push(next.trim());
    }

    const separator = scalar?.[1] === '|' ? '\n' : ' ';
    commands.push(parts.join(separator).replace(/\\\r?\n[\t ]*/gu, ' '));
  }
  return commands;
}

function localActionDefinitions(definition, projectRoot) {
  const canonicalRoot = realpathSync(projectRoot);
  const paths = [];
  const references = definition.matchAll(/^\s*(?:-\s*)?uses:\s*["']?(\.\/(?:[^"'\s#]+)?)["']?\s*(?:#.*)?$/gimu);
  for (const [, reference] of references) {
    if (reference.slice(2).split('/').includes('..')) throw new Error(`${reference} escapes the repository root.`);
    const actionRoot = resolve(projectRoot, reference.slice(2));
    if (actionRoot !== projectRoot && !actionRoot.startsWith(`${projectRoot}${sep}`)) {
      throw new Error(`${reference} escapes the repository root.`);
    }
    for (const name of ['action.yml', 'action.yaml']) {
      const path = resolve(actionRoot, name);
      if (!existsSync(path)) continue;
      const canonicalPath = realpathSync(path);
      const expectedPath = resolve(canonicalRoot, relative(projectRoot, path));
      if (!lstatSync(path).isFile() || canonicalPath !== expectedPath || !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
        throw new Error(`${relative(projectRoot, path)} must be a regular in-repository action definition.`);
      }
      paths.push(path);
    }
  }
  return paths;
}

function workflowDefinitions(root) {
  if (!existsSync(root)) return [];

  const definitions = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${path} must not be a symbolic link.`);
    } else if (entry.isDirectory()) {
      definitions.push(...workflowDefinitions(path));
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      if (!entry.isFile()) throw new Error(`${path} must be a regular workflow file.`);
      definitions.push(path);
    }
  }
  return definitions;
}

function verifyReleaseWorkflows(target, projectRoot) {
  if (!target.managed_paths.includes('release')) return;

  const definitions = new Set([
    ...workflowDefinitions(resolve(projectRoot, '.github/workflows')),
    ...workflowDefinitions(resolve(projectRoot, '.github/actions')),
  ]);
  for (const path of definitions) {
    const definition = readFileSync(path, 'utf8');
    for (const localPath of localActionDefinitions(definition, projectRoot)) definitions.add(localPath);
    if (
      directPublisherAction.test(definition) ||
      workflowCommands(definition).some(containsDirectPublisher)
    ) {
      throw new Error(`${relative(projectRoot, path)} contains a direct WordPress.org publisher instead of the fleet-managed release job.`);
    }
  }
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

  verifyReleaseWorkflows(matches[0], projectRoot);
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
