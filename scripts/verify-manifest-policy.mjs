#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desiredFiles, loadInventory } from './sync-plugin-standards.mjs';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function comparableManifest(manifest) {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== '$schema').sort(([left], [right]) => left.localeCompare(right)));
}

const svnWriteCommands = new Set(['ci', 'commit', 'copy', 'cp', 'dcommit', 'delete', 'del', 'import', 'lock', 'mkdir', 'move', 'mv', 'pd', 'pdel', 'pe', 'pedit', 'propdel', 'propedit', 'propset', 'ps', 'pset', 'remove', 'ren', 'rename', 'rm', 'unlock']);
const svnAlwaysRemoteWriteCommands = new Set(['ci', 'commit', 'dcommit', 'import', 'lock', 'unlock']);
const svnReadOnlyCommands = new Set(['annotate', 'blame', 'cat', 'checkout', 'co', 'cleanup', 'diff', 'export', 'help', 'info', 'list', 'log', 'ls', 'mergeinfo', 'pg', 'pl', 'praise', 'propget', 'proplist', 'stat', 'status', 'st', 'update', 'up']);
const svnOptionsWithValues = new Set(['--accept', '--change', '--changelist', '--cl', '--config-dir', '--config-option', '--depth', '--diff-cmd', '--diff3-cmd', '--editor-cmd', '--encoding', '--extensions', '--file', '--limit', '--message', '--native-eol', '--new', '--old', '--password', '--revision', '--search', '--set-depth', '--show-revs', '--strip', '--targets', '--trust-server-cert-failures', '--username', '--with-revprop', '-c', '-F', '-l', '-m', '-r', '-x']);
const svnRdumpWriteCommands = new Set(['load']);
const svnSyncWriteCommands = new Set(['copy-revprops', 'init', 'sync']);
const commandWrappers = new Set(['command', 'env', 'exec', 'nice', 'nohup', 'sudo', 'time', 'timeout', 'xargs']);
const shellCommands = new Set(['bash', 'dash', 'eval', 'ksh', 'sh', 'zsh']);
const shellControlPrefixes = new Set(['!', '(', '{', 'do', 'else', 'if', 'then']);

function shellSegments(command) {
  const normalized = command
    .replace(/\$\(\s*(?:command\s+-v|which|type\s+-P)\s+(?:svn|svnmucc)\s*\)/giu, (match) => match.toLowerCase().includes('svnmucc') ? 'svnmucc' : 'svn')
    .replace(/`\s*(?:command\s+-v|which|type\s+-P)\s+(?:svn|svnmucc)\s*`/giu, (match) => match.toLowerCase().includes('svnmucc') ? 'svnmucc' : 'svn');
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
    if (character === '#' && (index === 0 || /\s/u.test(normalized[index - 1]))) {
      while (index + 1 < normalized.length && normalized[index + 1] !== '\n') index += 1;
      if (current.trim()) segments.push(current.trim());
      current = '';
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
    if (substitutionDepth === 0 && (character === '\n' || character === ';' || character === '|' || character === '&')) {
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
  const tokens = [];
  let current = '';
  let quote = '';

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === '\\') {
      if (command[index + 1] !== undefined) current += command[index += 1];
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function executableName(token) {
  return basename(token.replace(/^[({]+|[),}]+$/gu, '')).toLowerCase();
}

function hasWriteCommand(tokens, commands) {
  return tokens.some((token) => commands.has(token.replace(/[),}]+$/gu, '').toLowerCase()));
}

function svnSubcommand(tokens) {
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    const optionName = option.includes('=') ? option.slice(0, option.indexOf('=')) : option;
    index += svnOptionsWithValues.has(optionName) && !option.includes('=') ? 2 : 1;
  }
  return { command: tokens[index]?.replace(/[),}]+$/gu, '').toLowerCase(), index };
}

function svnWritesRemotely(tokens) {
  if (tokens[0] === '--version') return false;
  const { command, index: commandIndex } = svnSubcommand(tokens);
  if (!command) return true;
  if (svnReadOnlyCommands.has(command)) return false;
  if (!svnWriteCommands.has(command)) return true;
  if (svnAlwaysRemoteWriteCommands.has(command)) return true;
  if (tokens.some((token) => /^(?:--targets|-targets)(?:=|$)/u.test(token))) return true;
  return tokens.slice(commandIndex + 1).some((token) => {
    if (/^(?:\$\{?(?:RUNNER_TEMP|GITHUB_WORKSPACE|TMPDIR)\}?)(?:\/|$)/u.test(token)) return false;
    return /(?:\$|:\/\/|^\^\/)/u.test(token);
  });
}

function isSvnVariable(token) {
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(token) && token.toUpperCase().includes('SVN');
}

function commandSubstitutions(command) {
  const substitutions = [];
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (character === "'") {
      quote = character;
      continue;
    }
    if (character === '`') {
      let end = index + 1;
      for (; end < command.length; end += 1) {
        if (command[end] === '\\') end += 1;
        else if (command[end] === '`') break;
      }
      if (end < command.length) substitutions.push(command.slice(index + 1, end));
      index = end;
      continue;
    }
    if (!['$', '<', '>'].includes(character) || command[index + 1] !== '(') continue;
    let depth = 1;
    let nestedQuote = '';
    let end = index + 2;
    for (; end < command.length && depth > 0; end += 1) {
      const nested = command[end];
      if (nested === '\\') {
        end += 1;
        continue;
      }
      if (nestedQuote) {
        if (nested === nestedQuote) nestedQuote = '';
        continue;
      }
      if (nested === '"' || nested === "'") {
        nestedQuote = nested;
        continue;
      }
      if (nested === '(') depth += 1;
      else if (nested === ')') depth -= 1;
    }
    if (depth === 0) substitutions.push(command.slice(index + 2, end - 1));
    index = end - 1;
  }
  return substitutions;
}

function segmentContainsDirectPublisher(segment) {
  const tokens = shellTokens(segment);
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '') || shellControlPrefixes.has(tokens[index]?.toLowerCase())) index += 1;
  let variableExecutable = isSvnVariable(tokens[index] ?? '');
  let executable = executableName(tokens[index] ?? '');
  let arguments_ = tokens.slice(index + 1);

  if (['echo', 'printf'].includes(executable)) return false;
  if (executable === 'command' && arguments_[0] === '-v') return false;

  if (commandWrappers.has(executable)) {
    let nestedIndex = arguments_.findIndex((token) => ['svn', 'svnmucc', 'svnrdump', 'svnsync'].includes(executableName(token)));
    if (nestedIndex < 0 && isSvnVariable(arguments_[0] ?? '')) nestedIndex = 0;
    if (nestedIndex < 0) return false;
    variableExecutable = isSvnVariable(arguments_[nestedIndex]);
    executable = executableName(arguments_[nestedIndex]);
    arguments_ = arguments_.slice(nestedIndex + 1);
  }

  if (variableExecutable && svnWritesRemotely(arguments_)) return true;
  if (executable === 'svnmucc') return true;
  if (executable === 'svn' && svnWritesRemotely(arguments_)) return true;
  if (executable === 'svnrdump' && hasWriteCommand(arguments_, svnRdumpWriteCommands)) return true;
  if (executable === 'svnsync' && hasWriteCommand(arguments_, svnSyncWriteCommands)) return true;
  if (executable === 'git' && executableName(arguments_[0] ?? '') === 'svn' && hasWriteCommand(arguments_.slice(1), new Set(['dcommit']))) return true;
  if (shellCommands.has(executable)) {
    const nested = arguments_.filter((token) => !token.startsWith('-')).join(' ');
    if (/\b(?:svn|svnmucc|svnrdump|svnsync)\b/iu.test(nested)) return containsDirectPublisher(nested);
  }
  if (executable === 'git' && hasWriteCommand(arguments_, new Set(['dcommit'])) && arguments_.some((token) => executableName(token) === 'svn')) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/u.test(tokens[index] ?? '') || tokens.slice(index + 1).includes('{')) {
    for (let candidate = index + 1; candidate < tokens.length; candidate += 1) {
      const candidateExecutable = executableName(tokens[candidate]);
      const candidateArguments = tokens.slice(candidate + 1);
      if (isSvnVariable(tokens[candidate]) && svnWritesRemotely(candidateArguments)) return true;
      if (candidateExecutable === 'svnmucc') return true;
      if (candidateExecutable === 'svn' && svnWritesRemotely(candidateArguments)) return true;
      if (candidateExecutable === 'svnrdump' && hasWriteCommand(candidateArguments, svnRdumpWriteCommands)) return true;
      if (candidateExecutable === 'svnsync' && hasWriteCommand(candidateArguments, svnSyncWriteCommands)) return true;
    }
  }
  return false;
}

function containsDirectPublisher(command) {
  for (const substitution of commandSubstitutions(command)) {
    if (containsDirectPublisher(substitution)) return true;
  }
  return shellSegments(command).some(segmentContainsDirectPublisher);
}

function yamlCode(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\\' && quote === '"') {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '#' && (index === 0 || /\s/u.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

function containsDirectPublisherAction(definition) {
  return definition.split(/\r?\n/u).some((rawLine) => {
    const line = yamlCode(rawLine);
    if (/^\s*(?:-\s+)?["']?uses["']?\s*:\s*(?:$|[>|]|[&*!])/iu.test(line)) return true;
    return /(?:^\s*(?:-\s+)?|[{,]\s*)["']?uses["']?\s*:\s*["']?[A-Za-z0-9_.-]+\/action-wordpress-plugin-(?:asset-update|deploy)@/iu.test(line);
  });
}

function containsUnexpectedPublisherCredentials(definition, path, projectRoot) {
  const credential = /\b(?:(?:STUTTTER_)?(?:WORDPRESS|WP)_ORG|WPORG|SVN)_(?:USERNAME|USER|PASSWORD|PASS)\b/iu;
  const allowedCaller = relative(projectRoot, path) === '.github/workflows/release.yml';
  if (allowedCaller) return false;
  if (credential.test(definition)) return true;
  for (const match of definition.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)) {
    const unnamed = match[1].replace(/\bsecrets\.[A-Za-z_][A-Za-z0-9_]*\b/gu, '');
    if (/\bsecrets\b/iu.test(unnamed)) return true;
  }
  const lines = definition.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*#/u.test(lines[index])) continue;
    const match = /^(\s*)(?:-\s+)?["']?secrets["']?\s*:\s*(.*)$/iu.exec(lines[index]);
    if (!match) continue;
    const value = yamlCode(match[2]).trim();
    if (value) return true;
    for (let nested = index + 1; nested < lines.length; nested += 1) {
      if (!lines[nested].trim() || /^\s*#/u.test(lines[nested])) continue;
      const indent = /^\s*/u.exec(lines[nested])[0].length;
      if (indent <= match[1].length) break;
      if (/^\s*["']?inherit["']?\s*(?:#.*)?$/iu.test(lines[nested])) return true;
      break;
    }
  }
  return false;
}

function containsUnsupportedYamlEscape(definition) {
  return definition.split(/\r?\n/u).some((line) => !/^\s*#/u.test(line) && /:\s*"[^"\r\n]*\\/u.test(line));
}

function quotedYamlScalar(value) {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  for (let index = 1; index < value.length; index += 1) {
    if (quote === '"' && value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] !== quote) continue;
    if (quote === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    const remainder = value.slice(index + 1).trim();
    if (!remainder || /^(?:#.*|[},].*)$/u.test(remainder)) return value.slice(1, index).replace(/''/gu, "'");
    return value;
  }
  throw new Error('Quoted workflow run values must be statically inspectable.');
}

function workflowCommands(definition) {
  const lines = definition.split(/\r?\n/u);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*#/u.test(lines[index])) continue;
    const match = /(?:^\s*(?:-\s+)?|[{,]\s*)["']?run["']?\s*:\s*(.*)$/iu.exec(lines[index]);
    if (!match) continue;

    const runKey = /["']?run["']?\s*:/iu.exec(lines[index]);
    const baseIndent = runKey.index;
    let value = match[1].trim();
    if (/^!!/u.test(value)) throw new Error('Workflow contains a direct WordPress.org publisher or an unsupported tagged run value.');
    if (/^\*[A-Za-z0-9_-]+(?:\s+#.*)?[},]?$/u.test(value)) {
      throw new Error('Workflow run aliases are unsupported by the direct-publisher policy.');
    }
    value = value.replace(/^&[A-Za-z0-9_-]+\s+/u, '');
    value = quotedYamlScalar(value);
    const scalar = /^([>|])(?:[-+]\d*)?\s*(?:#.*)?$/u.exec(value);
    const parts = scalar ? [] : [value];
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
  const references = definition.split(/\r?\n/u).flatMap((rawLine) => {
    const line = yamlCode(rawLine);
    const match = /(?:^\s*(?:-\s+)?|[{,]\s*)["']?uses["']?\s*:\s*["']?(\.\/(?:[^"'\s#,}]+)?)/iu.exec(line);
    return match ? [match[1]] : [];
  });
  for (const reference of references) {
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
      if (/\.ya?ml$/iu.test(entry.name) || statSync(path).isDirectory()) throw new Error(`${path} must not be a symbolic link.`);
    } else if (entry.isDirectory()) {
      definitions.push(...workflowDefinitions(path));
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      if (!entry.isFile()) throw new Error(`${path} must be a regular workflow file.`);
      definitions.push(path);
    }
  }
  return definitions;
}

function verifyReleaseWorkflows(target, projectRoot, policyRef) {
  if (!target.managed_paths.includes('release')) return;
  if (typeof policyRef !== 'string' || !/^[0-9a-f]{40}$/u.test(policyRef)) throw new Error('The immutable fleet policy reference is invalid.');

  const releasePath = resolve(projectRoot, '.github/workflows/release.yml');
  const releaseDefinition = readFileSync(releasePath, 'utf8');
  const expectedRelease = desiredFiles(projectRoot, target, policyRef).get('.github/workflows/release.yml');
  if (releaseDefinition !== expectedRelease) {
    throw new Error('.github/workflows/release.yml differs from the fleet-managed release caller.');
  }

  const definitions = new Set([
    ...workflowDefinitions(resolve(projectRoot, '.github/workflows')),
    ...workflowDefinitions(resolve(projectRoot, '.github/actions')),
  ]);
  for (const path of definitions) {
    const definition = readFileSync(path, 'utf8');
    for (const localPath of localActionDefinitions(definition, projectRoot)) definitions.add(localPath);
    if (
      containsUnsupportedYamlEscape(definition) ||
      containsDirectPublisherAction(definition) ||
      containsUnexpectedPublisherCredentials(definition, path, projectRoot) ||
      workflowCommands(definition).some(containsDirectPublisher)
    ) {
      throw new Error(`${relative(projectRoot, path)} contains a direct WordPress.org publisher instead of the fleet-managed release job.`);
    }
  }
}

export function verifyManifestPolicy(inventory, repository, projectRoot, policyRef) {
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

  verifyReleaseWorkflows(matches[0], projectRoot, policyRef);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--repository', '--project-root', '--policy-ref'].includes(argv[index]) || !argv[index + 1]) throw new Error('Usage: verify-manifest-policy.mjs --repository owner/repository --project-root path --policy-ref sha');
    options[argv[index].slice(2).replace('-', '_')] = argv[index + 1];
  }
  if (!options.repository || !options.project_root || !options.policy_ref || Object.keys(options).length !== 3) throw new Error('Usage: verify-manifest-policy.mjs --repository owner/repository --project-root path --policy-ref sha');
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const inventory = loadInventory(resolve(scriptRoot, 'portfolio/plugins.json'));
    verifyManifestPolicy(inventory, options.repository, resolve(options.project_root), options.policy_ref);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
