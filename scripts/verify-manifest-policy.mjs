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
const svnOptionsWithValues = new Set(['--accept', '--change', '--changelist', '--cl', '--config-dir', '--config-option', '--depth', '--diff-cmd', '--diff3-cmd', '--editor-cmd', '--encoding', '--extra-args', '--extensions', '--file', '--limit', '--message', '--native-eol', '--new', '--old', '--password', '--revision', '--root-url', '--search', '--set-depth', '--show-revs', '--source-password', '--source-username', '--strip', '--sync-password', '--sync-username', '--targets', '--trust-server-cert-failures', '--username', '--with-revprop', '-c', '-F', '-l', '-m', '-p', '-r', '-u', '-U', '-x', '-X']);
const svnRdumpWriteCommands = new Set(['load']);
const svnSyncWriteCommands = new Set(['copy-revprops', 'init', 'sync']);
const gitSvnWriteCommands = new Set(['branch', 'dcommit', 'set-tree', 'tag']);
const svnMuccWriteCommands = new Set(['cp', 'mkdir', 'mv', 'propdel', 'propset', 'put', 'rm']);
const dynamicPublisherWriteCommands = new Set([...svnAlwaysRemoteWriteCommands, ...svnRdumpWriteCommands, ...svnSyncWriteCommands, 'put']);
const commandWrappers = new Set(['builtin', 'command', 'doas', 'env', 'exec', 'find', 'flock', 'ionice', 'nice', 'nohup', 'parallel', 'setsid', 'stdbuf', 'sudo', 'time', 'timeout', 'watch', 'xargs']);
const shellCommands = new Set(['bash', 'dash', 'eval', 'ksh', 'sh', 'trap', 'zsh']);
const shellControlPrefixes = new Set(['!', '(', '{', 'coproc', 'do', 'elif', 'else', 'if', 'then', 'until', 'while']);

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
    let escapedBoundary = false;
    if (character === '#' && index > 0 && /\s/u.test(normalized[index - 1])) {
      let slashes = 0;
      for (let cursor = index - 2; cursor >= 0 && normalized[cursor] === '\\'; cursor -= 1) slashes += 1;
      escapedBoundary = slashes % 2 === 1;
    }
    if (character === '#' && (index === 0 || (/\s/u.test(normalized[index - 1]) && !escapedBoundary))) {
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
    const redirectionAmpersand = character === '&' && (['>', '<'].includes(normalized[index - 1]) || next === '>');
    if (substitutionDepth === 0 && !redirectionAmpersand && (character === '\n' || character === ';' || character === '|' || character === '&')) {
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
  let substitutionDepth = 0;
  let backtick = false;

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
    if (character === '`') {
      backtick = !backtick;
      current += character;
      continue;
    }
    if (!backtick && character === '$' && command[index + 1] === '(') {
      substitutionDepth += 1;
      current += '$(';
      index += 1;
      continue;
    }
    if (!backtick && character === ')' && substitutionDepth > 0) {
      substitutionDepth -= 1;
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character) && !backtick && substitutionDepth === 0) {
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

function isDynamicExecutable(token) {
  return /[$`*?\[]/u.test(token);
}

function dynamicPublisherWritesRemotely(tokens) {
  const { command } = svnSubcommand(tokens);
  if (dynamicPublisherWriteCommands.has(command)) return true;
  return svnWriteCommands.has(command) && svnWritesRemotely(tokens);
}

function shellInvocationContainsPublisher(executable, arguments_) {
  if (executable === 'eval' || executable === 'trap') return containsDirectPublisher(arguments_.join(' '));
  const commandIndex = arguments_.findIndex((token) => token === '-c' || /^-[^-]*c[^-]*$/u.test(token));
  if (commandIndex >= 0 && commandIndex + 1 < arguments_.length) {
    const script = arguments_[commandIndex + 1];
    if (containsDirectPublisher(script)) return true;
    if (/\$\{?0\}?/u.test(script) && containsDirectPublisher(arguments_.slice(commandIndex + 2).join(' '))) return true;
    if (/\$\{?[@*]\}?/u.test(script) && containsDirectPublisher(arguments_.slice(commandIndex + 3).join(' '))) return true;
  }
  const hereString = arguments_.indexOf('<<<');
  return hereString >= 0 && containsDirectPublisher(arguments_.slice(hereString + 1).join(' '));
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
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token) || shellControlPrefixes.has(token.toLowerCase()) || (!token.includes('$(') && /\)$/u.test(token))) {
      index += 1;
      continue;
    }
    if (/^(?:\d*|&)?(?:>{1,2}|<{1,2}|<>|>&|<&)/u.test(token)) {
      index += /^(?:\d*|&)?(?:>{1,2}|<{1,2}|<>|>&|<&)$/u.test(token) ? 2 : 1;
      continue;
    }
    break;
  }
  let dynamicExecutable = isDynamicExecutable(tokens[index] ?? '');
  let executable = executableName(tokens[index] ?? '');
  let arguments_ = tokens.slice(index + 1);

  if (['echo', 'printf'].includes(executable)) return false;
  if (executable === 'command' && arguments_[0] === '-v') return false;

  if (commandWrappers.has(executable)) {
    for (let candidate = 0; candidate < arguments_.length; candidate += 1) {
      const candidateExecutable = executableName(arguments_[candidate]);
      const candidateArguments = arguments_.slice(candidate + 1);
      if (isDynamicExecutable(arguments_[candidate]) && dynamicPublisherWritesRemotely(candidateArguments)) return true;
      if (candidateExecutable === 'svnmucc' && hasWriteCommand(candidateArguments, svnMuccWriteCommands)) return true;
      if (candidateExecutable === 'svn') {
        const { command } = svnSubcommand(candidateArguments);
        if (executable === 'xargs') return true;
        if (svnWriteCommands.has(command) && svnWritesRemotely(candidateArguments)) return true;
      }
      if (candidateExecutable === 'svnrdump' && hasWriteCommand(candidateArguments, svnRdumpWriteCommands)) return true;
      if (candidateExecutable === 'svnsync' && hasWriteCommand(candidateArguments, svnSyncWriteCommands)) return true;
      if (shellCommands.has(candidateExecutable) && shellInvocationContainsPublisher(candidateExecutable, candidateArguments)) return true;
      if (/^(?:node|perl|php|python\d*(?:\.\d+)?|ruby)$/u.test(candidateExecutable)
        && /\bsvn(?:mucc|rdump|sync)?\b[\s\S]*\b(?:branch|ci|commit|copy|cp|dcommit|delete|del|import|init|load|lock|mkdir|move|mv|pd|pdel|pe|pedit|propdel|propedit|propset|ps|pset|put|remove|ren|rename|rm|set-tree|sync|tag|unlock)\b/iu.test(candidateArguments.join(' '))) return true;
    }
    return false;
  }

  if (executable === 'case') {
    const patternIndex = arguments_.findIndex((token) => /\)$/u.test(token));
    return patternIndex >= 0 && segmentContainsDirectPublisher(arguments_.slice(patternIndex + 1).join(' '));
  }

  if (dynamicExecutable && dynamicPublisherWritesRemotely(arguments_)) return true;
  if (executable === 'svnmucc') return true;
  if (executable === 'svn' && svnWritesRemotely(arguments_)) return true;
  if (executable === 'svnrdump' && hasWriteCommand(arguments_, svnRdumpWriteCommands)) return true;
  if (executable === 'svnsync' && hasWriteCommand(arguments_, svnSyncWriteCommands)) return true;
  if (executable === 'git' && executableName(arguments_[0] ?? '') === 'svn' && hasWriteCommand(arguments_.slice(1), gitSvnWriteCommands)) return true;
  if (executable === 'git-svn' && hasWriteCommand(arguments_, gitSvnWriteCommands)) return true;
  if (shellCommands.has(executable)) {
    return shellInvocationContainsPublisher(executable, arguments_);
  }
  if (/^(?:node|perl|php|python\d*(?:\.\d+)?|ruby)$/u.test(executable)) {
    const nested = arguments_.join(' ');
    if (/\bsvn(?:mucc|rdump|sync)?\b[\s\S]*\b(?:ci|commit|copy|cp|dcommit|delete|del|import|init|load|lock|mkdir|move|mv|pd|pdel|pe|pedit|propdel|propedit|propset|ps|pset|put|remove|ren|rename|rm|sync|unlock)\b/iu.test(nested)) return true;
  }
  if (executable === 'git' && hasWriteCommand(arguments_, gitSvnWriteCommands) && arguments_.some((token) => executableName(token) === 'svn')) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/u.test(tokens[index] ?? '') || tokens.slice(index + 1).includes('{')) {
    for (let candidate = index + 1; candidate < tokens.length; candidate += 1) {
      const candidateExecutable = executableName(tokens[candidate]);
      const candidateArguments = tokens.slice(candidate + 1);
      if (isDynamicExecutable(tokens[candidate]) && dynamicPublisherWritesRemotely(candidateArguments)) return true;
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
  if (/\|\s*(?:bash|dash|ksh|sh|zsh)\b/iu.test(command)
    && /\bsvn(?:mucc|rdump|sync)?\b[\s\S]*\b(?:branch|ci|commit|dcommit|import|init|load|lock|put|set-tree|sync|tag|unlock)\b/iu.test(command)) return true;
  return shellSegments(command).some(segmentContainsDirectPublisher);
}

function containsInterpreterShellPublisher(definition) {
  const inspected = withoutYamlComments(definition);
  if (!/^\s*(?:-\s+)?shell\s*:\s*["']?(?:node|perl|php|powershell|pwsh|python\d*(?:\.\d+)?|ruby)\b/imu.test(inspected)) return false;
  return /\b(?:git\s+svn|git-svn|svn|svnmucc|svnrdump|svnsync)\b[\s\S]{0,512}\b(?:branch|ci|commit|copy|cp|dcommit|delete|del|import|init|load|lock|mkdir|move|mv|pd|pdel|pe|pedit|propdel|propedit|propset|ps|pset|put|remove|ren|rename|rm|set-tree|sync|tag|unlock)\b/iu.test(inspected);
}

function yamlQuotedScalarStarts(line, index) {
  return /(?:^|[:\-,[?{])\s*(?:(?:&|!!?)[^\s,}\]]+\s+)*$/u.test(line.slice(0, index));
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
      if (quote === "'" && character === "'" && line[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (character === quote) quote = '';
      continue;
    }
    if ((character === '"' || character === "'") && yamlQuotedScalarStarts(line, index)) quote = character;
    else if (character === '#' && (index === 0 || /\s/u.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

function yamlQuoteState(line, initial = '') {
  let quote = initial;
  let index = 0;
  if (!quote) {
    const start = /(?:^\s*(?:-\s+)?|[{,]\s*)["']?[A-Za-z0-9_.-]+["']?\s*:\s*(?:(?:&|!!?)[^\s,}\]]+\s+)*(["'])/u.exec(line)
      ?? /^\s*(?:-\s+)?(?:(?:&|!!?)[^\s,}\]]+\s+)*(["'])/u.exec(line);
    if (!start) return '';
    quote = start[1];
    index = start.index + start[0].length;
  }
  for (; index < line.length; index += 1) {
    if (quote === '"' && line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line[index] !== quote) continue;
    if (quote === "'" && line[index + 1] === "'") {
      index += 1;
      continue;
    }
    return yamlQuoteState(yamlCode(line.slice(index + 1)));
  }
  return quote;
}

function withoutYamlComments(definition) {
  const lines = definition.split(/\r?\n/u);
  let blockIndent = null;
  let quote = '';
  return lines.map((line) => {
    const indent = /^\s*/u.exec(line)[0].length;
    if (blockIndent !== null && (!line.trim() || indent > blockIndent)) return line;
    blockIndent = null;
    if (quote) {
      quote = yamlQuoteState(line, quote);
      return line;
    }
    if (/^\s*#/u.test(line)) return '';
    const code = yamlCode(line);
    quote = yamlQuoteState(code);
    if (/(?:^\s*|:)\s*(?:(?:&|!!?)[^\s,}\]]+\s+)*[>|](?:(?:[1-9][-+]?)|(?:[-+][1-9]?))?\s*$/u.test(code)) blockIndent = indent;
    return code;
  }).join('\n');
}

function isActionInput(lines, index, indent) {
  let parentIndex = -1;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!lines[cursor].trim() || /^\s*#/u.test(lines[cursor])) continue;
    const candidateIndent = /^\s*/u.exec(lines[cursor])[0].length;
    if (candidateIndent >= indent) continue;
    const key = /^\s*(?:-\s+)?["']?([A-Za-z0-9_.-]+)["']?\s*:/u.exec(lines[cursor])?.[1];
    if (key !== 'with') return false;
    parentIndex = cursor;
    break;
  }
  if (parentIndex < 0) return false;

  let stepIndex = -1;
  let stepIndent = -1;
  for (let cursor = parentIndex; cursor >= 0; cursor -= 1) {
    if (!lines[cursor].trim() || /^\s*#/u.test(lines[cursor])) continue;
    const candidateIndent = /^\s*/u.exec(lines[cursor])[0].length;
    if (!/^\s*-\s+/u.test(lines[cursor])) continue;
    stepIndex = cursor;
    stepIndent = candidateIndent;
    break;
  }
  if (stepIndex < 0) return false;
  const parentIndent = /^\s*/u.exec(lines[parentIndex])[0].length;
  if (stepIndex !== parentIndex && stepIndent >= parentIndent) return false;

  for (let cursor = stepIndex; cursor < lines.length; cursor += 1) {
    if (!lines[cursor].trim() || /^\s*#/u.test(lines[cursor])) continue;
    const candidateIndent = /^\s*/u.exec(lines[cursor])[0].length;
    if (cursor > stepIndex && candidateIndent <= stepIndent) break;
    if (/^\s*(?:-\s+)?["']?uses["']?\s*:/iu.test(lines[cursor])) return true;
  }
  return false;
}

function workflowExpressions(definition) {
  const expressions = [];
  for (let start = definition.indexOf('${{'); start >= 0; start = definition.indexOf('${{', start + 3)) {
    let quote = false;
    let end = start + 3;
    for (; end < definition.length; end += 1) {
      if (definition[end] === "'") {
        if (quote && definition[end + 1] === "'") {
          end += 1;
          continue;
        }
        quote = !quote;
        continue;
      }
      if (!quote && definition[end] === '}' && definition[end + 1] === '}') break;
    }
    expressions.push(definition.slice(start + 3, end));
    if (end >= definition.length) break;
    start = end - 1;
  }
  return expressions;
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
  const inspected = withoutYamlComments(definition);
  if (credential.test(inspected)) return true;
  for (const expression of workflowExpressions(inspected)) {
    const unnamed = expression.replace(/\bsecrets\.[A-Za-z_][A-Za-z0-9_]*\b/gu, '');
    if (/\bsecrets\b/iu.test(unnamed)) return true;
  }
  const lines = inspected.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*#/u.test(lines[index])) continue;
    if (/(?:^|[{,]\s*)["']?secrets["']?\s*:\s*(?:(?:&|!!?)[^\s,}\]]+\s+)*["']?inherit["']?(?:\s*[,}]|\s*$)/iu.test(yamlCode(lines[index]))) return true;
    const match = /^(\s*)(?:-\s+)?["']?secrets["']?\s*:\s*(.*)$/iu.exec(lines[index]);
    if (!match) continue;
    if (isActionInput(lines, index, match[1].length)) continue;
    const value = yamlCode(match[2]).trim();
    if (value && !/^\{[\s\S]*\}$/u.test(value)) return true;
    for (let nested = index + 1; nested < lines.length; nested += 1) {
      if (!lines[nested].trim() || /^\s*#/u.test(lines[nested])) continue;
      const indent = /^\s*/u.exec(lines[nested])[0].length;
      if (indent <= match[1].length) break;
      if (/^\s*(?:(?:&|!!?)[^\s,}\]]+\s+)*["']?inherit["']?\s*(?:#.*)?$/iu.test(lines[nested])) return true;
      break;
    }
  }
  return false;
}

function containsUnsupportedYamlEscape(definition) {
  let quoted = false;
  const lines = definition.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!quoted && /^\s*#/u.test(line)) continue;
    const scalarStarts = [...line.matchAll(/(?:^\s*(?:-\s+)?|[{,]\s*)["']?[A-Za-z0-9_.-]+["']?\s*:\s*(?:(?:&|!!?)[^\s,}\]]+\s+)*"/gu)]
      .map((match) => match.index + match[0].lastIndexOf('"'));
    if (!quoted && scalarStarts.length === 0 && /(?:^\s*|:)\s*(?:(?:&|!!?)[^\s,}\]]+\s+)*[>|](?:(?:[1-9][-+]?)|(?:[-+][1-9]?))?\s*$/u.test(yamlCode(line))) {
      const baseIndent = /^\s*/u.exec(line)[0].length;
      while (lineIndex + 1 < lines.length) {
        const next = lines[lineIndex + 1];
        const indent = /^\s*/u.exec(next)[0].length;
        if (next.trim() && indent <= baseIndent) break;
        lineIndex += 1;
      }
      continue;
    }
    let index = 0;
    while (index < line.length) {
      if (!quoted) {
        const start = scalarStarts.find((position) => position >= index);
        if (start === undefined) break;
        index = start + 1;
        quoted = true;
      }
      while (quoted && index < line.length) {
        if (line[index] === '\\') return true;
        if (line[index] === '"') quoted = false;
        index += 1;
      }
    }
  }
  return false;
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
    const scalar = /^([>|])(?:(?:[1-9][-+]?)|(?:[-+][1-9]?))?\s*(?:#.*)?$/u.exec(value);
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
    if (parts.length > 1 && separator !== '\n') commands.push(parts.join('\n').replace(/\\\r?\n[\t ]*/gu, ' '));
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
      containsInterpreterShellPublisher(definition) ||
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
