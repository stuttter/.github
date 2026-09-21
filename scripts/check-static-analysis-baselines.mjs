#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASELINE_FILES = Object.freeze({
  'phpcs-baseline.json': parsePhpcsBaseline,
  'phpstan-baseline.neon': parsePhpstanBaseline,
});

const ANALYZER_CONTRACTS = Object.freeze({
  'phpcs-baseline.json': Object.freeze({
    script: 'phpcs',
    configurations: Object.freeze([
      '.phpcs.xml',
      '.phpcs.xml.dist',
      'phpcs.xml',
      'phpcs.xml.dist',
    ]),
  }),
  'phpstan-baseline.neon': Object.freeze({
    script: 'phpstan',
    configurations: Object.freeze([
      'phpstan.neon',
      'phpstan.neon.dist',
    ]),
  }),
});

function parseCount(value, context) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${context} must be a non-negative integer.`);
  }

  return value;
}

function parseNeonStringScalar(value, context, requireQuoted = false) {
  const scalar = value.trim();
  if (scalar === '') {
    throw new Error(`${context} must be a non-empty string scalar.`);
  }

  if (scalar.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/u.test(scalar)) {
      throw new Error(`${context} has an invalid single-quoted string scalar.`);
    }
    const decoded = scalar.slice(1, -1).replaceAll("''", "'");
    if (decoded === '') throw new Error(`${context} must be a non-empty string scalar.`);
    return decoded;
  }

  if (scalar.startsWith('"')) {
    try {
      const decoded = JSON.parse(scalar);
      if (typeof decoded !== 'string' || decoded === '') throw new Error('empty string');
      return decoded;
    } catch {
      throw new Error(`${context} has an invalid double-quoted string scalar.`);
    }
  }

  if (requireQuoted) {
    throw new Error(`${context} must use a quoted string scalar.`);
  }

  if (!/^[A-Za-z0-9_./%:+*?-]+$/u.test(scalar)
    || /^(?:true|false|yes|no|on|off|null|~)$/iu.test(scalar)
    || /^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(scalar)) {
    throw new Error(`${context} must be a plain or quoted string scalar.`);
  }

  return scalar;
}

export function parsePhpcsBaseline(source, label = 'phpcs-baseline.json') {
  let decoded;

  try {
    decoded = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }

  if (decoded === null || Array.isArray(decoded) || typeof decoded !== 'object') {
    throw new Error(`${label} must contain an object of allowance keys and counts.`);
  }

  const allowances = new Map();
  for (const [key, count] of Object.entries(decoded)) {
    allowances.set(key, parseCount(count, `${label}: ${key}`));
  }

  return allowances;
}

function indentation(line) {
  const prefix = line.match(/^[\t ]*/u)[0];
  return [...prefix].reduce((width, character) => width + (character === '\t' ? 2 : 1), 0);
}

function canonicalPhpstanEntry(lines, label, index) {
  const properties = new Map();
  const seen = new Set();
  let count = null;

  for (const line of lines) {
    const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.+)$/u);
    if (!match) {
      throw new Error(`${label}: ignoreErrors entry ${index} uses an unsupported multiline value.`);
    }

    const [, name, value] = match;
    if (seen.has(name)) {
      throw new Error(`${label}: ignoreErrors entry ${index} repeats ${name}.`);
    }
    seen.add(name);

    if (!['message', 'identifier', 'count', 'path'].includes(name)) {
      throw new Error(`${label}: ignoreErrors entry ${index} uses unsupported property ${name}.`);
    }

    if (name === 'count') {
      if (!/^[1-9][0-9]*$/u.test(value)) {
        throw new Error(`${label}: ignoreErrors entry ${index} must have a positive count.`);
      }
      count = parseCount(Number(value), `${label}: ignoreErrors entry ${index} count`);
      continue;
    }

    const context = `${label}: ignoreErrors entry ${index} ${name}`;
    properties.set(name, parseNeonStringScalar(value, context, name === 'message'));
  }

  if (!properties.has('message') || !properties.has('path')) {
    throw new Error(`${label}: ignoreErrors entry ${index} must have a message and path.`);
  }

  if (count === null) {
    throw new Error(`${label}: ignoreErrors entry ${index} must have an explicit positive count.`);
  }

  const key = [...properties.entries()]
    .sort(([left], [right]) => left.localeCompare(right));

  return [JSON.stringify(key), count];
}

export function parsePhpstanBaseline(source, label = 'phpstan-baseline.neon') {
  if (source.includes('\r')) {
    throw new Error(`${label} must use LF line endings.`);
  }

  const lines = source.split('\n')
    .map((line, index) => ({
      indent: indentation(line),
      number: index + 1,
      text: line.trim(),
    }))
    .filter((line) => line.text !== '' && !line.text.startsWith('#'));

  if (lines.length === 0 || lines[0].indent !== 0 || lines[0].text !== 'parameters:') {
    throw new Error(`${label} must begin with a canonical parameters block.`);
  }

  const marker = lines[1];
  if (!marker || marker.indent <= lines[0].indent || marker.text !== 'ignoreErrors:') {
    throw new Error(`${label} must contain one canonical parameters.ignoreErrors block.`);
  }

  const entries = [];
  let entryIndent = null;
  let propertyIndent = null;
  let current = [];

  for (const line of lines.slice(2)) {
    if (line.indent <= marker.indent) {
      throw new Error(`${label}: unsupported content outside parameters.ignoreErrors at line ${line.number}.`);
    }

    if (propertyIndent !== null && line.indent > propertyIndent) {
      throw new Error(`${label}: unsupported multiline value at line ${line.number}.`);
    }

    if (line.text === '-') {
      if (entryIndent === null) {
        entryIndent = line.indent;
      } else if (line.indent !== entryIndent) {
        throw new Error(`${label}: inconsistent list indentation at line ${line.number}.`);
      } else if (current.length === 0) {
        throw new Error(`${label}: empty ignoreErrors entry before line ${line.number}.`);
      }

      if (current.length > 0) {
        entries.push(current);
      }
      current = [];
      propertyIndent = null;
      continue;
    }

    if (line.text.startsWith('-')) {
      throw new Error(`${label}: inline ignoreErrors entries are not permitted at line ${line.number}.`);
    }

    if (entryIndent === null || line.indent <= entryIndent) {
      throw new Error(`${label}: ignoreErrors contains content outside a canonical list entry at line ${line.number}.`);
    }

    if (propertyIndent === null) {
      propertyIndent = line.indent;
    } else if (line.indent !== propertyIndent) {
      throw new Error(`${label}: unsupported multiline value at line ${line.number}.`);
    }

    current.push(line.text);
  }

  if (entryIndent !== null) {
    if (current.length === 0) {
      throw new Error(`${label}: final ignoreErrors entry is empty.`);
    }
    entries.push(current);
  }

  if (entries.length === 0) {
    throw new Error(`${label} must contain at least one counted ignoreErrors entry.`);
  }

  const allowances = new Map();
  entries.forEach((entry, index) => {
    const [key, count] = canonicalPhpstanEntry(entry, label, index + 1);
    if (allowances.has(key)) {
      throw new Error(`${label}: ignoreErrors entries ${index + 1} and an earlier entry are identical.`);
    }
    allowances.set(key, count);
  });

  return allowances;
}

export function compareAllowances(base, head, label) {
  if (label.includes('phpstan-baseline.neon')) {
    return comparePhpstanAllowances(base, head, label);
  }

  const increases = [];

  for (const [key, count] of head) {
    if (!base.has(key)) {
      increases.push(`${label}: ${key} is a new allowance key with count ${count}.`);
      continue;
    }
    const previous = base.get(key);
    if (count > previous) {
      increases.push(`${label}: ${key} increased from ${previous} to ${count}.`);
    }
  }

  return increases;
}

function literalPrefixPattern(pattern) {
  if (!pattern.startsWith('#^') || !pattern.endsWith('#')) return null;

  let body = pattern.slice(2, -1);
  let kind = 'prefix';
  const finalDollar = body.endsWith('$') && (body.match(/\\+\$$/u)?.[0].length ?? 1) % 2 === 1;
  if (finalDollar) {
    kind = 'exact';
    body = body.slice(0, -1);
  }
  if (body.endsWith('.*')) {
    if (!finalDollar) return null;
    kind = 'wildcard';
    body = body.slice(0, -2);
  }

  let literal = '';
  const metacharacters = new Set(['\\', '#', '.', '*', '+', '?', '[', ']', '(', ')', '{', '}', '|', '^', '$']);
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\') {
      const escaped = body[index + 1];
      if (escaped === undefined || /^[A-Za-z0-9]$/u.test(escaped)) return null;
      literal += escaped;
      index += 1;
    } else {
      if (metacharacters.has(character)) return null;
      literal += character;
    }
  }

  return { kind, literal };
}

function phpstanProperties(key) {
  try {
    return Object.fromEntries(JSON.parse(key));
  } catch {
    return null;
  }
}

function isProvablyNarrowerPhpstanEntry(baseKey, headKey) {
  const base = phpstanProperties(baseKey);
  const head = phpstanProperties(headKey);
  if (!base || !head || base.path !== head.path) return false;
  if (base.identifier !== head.identifier && !(base.identifier === undefined && head.identifier !== undefined)) return false;

  const baseMessage = literalPrefixPattern(base.message);
  const headMessage = literalPrefixPattern(head.message);
  if (!baseMessage || !headMessage) return false;
  if (!headMessage.literal.startsWith(baseMessage.literal)) return false;
  if (baseMessage.kind === 'exact') return baseMessage.literal === headMessage.literal && headMessage.kind === 'exact';
  if (baseMessage.kind === 'wildcard') return headMessage.kind !== 'prefix';
  return true;
}

function comparePhpstanAllowances(base, head, label) {
  const failures = [];
  const remaining = new Map(base);
  const exact = [...head].filter(([key]) => base.has(key));
  const narrowed = [...head].filter(([key]) => !base.has(key)).sort((left, right) => right[1] - left[1]);

  for (const [key, count] of exact) {
    const previous = remaining.get(key);
    if (count > previous) {
      failures.push(`${label}: ${key} increased from ${previous} to ${count}.`);
    } else {
      remaining.set(key, previous - count);
    }
  }

  for (const [headKey, count] of narrowed) {
    const candidates = [...remaining].filter(([baseKey, available]) => (
      available >= count && isProvablyNarrowerPhpstanEntry(baseKey, headKey)
    ));
    if (candidates.length !== 1) {
      const reason = candidates.length === 0 ? 'new or not provably narrower' : 'ambiguous between multiple base allowances';
      failures.push(`${label}: ${headKey} is ${reason} with capacity for count ${count}.`);
      continue;
    }
    const [candidate] = candidates;
    remaining.set(candidate[0], candidate[1] - count);
  }

  return failures;
}

function readAtRevision(revision, path) {
  try {
    return execFileSync('git', ['show', `${revision}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (/does not exist in|exists on disk, but not in/u.test(stderr)) {
      return null;
    }
    throw new Error(`Unable to read ${path} from ${revision}: ${stderr.trim() || error.message}`);
  }
}

function readHead(path) {
  if (!existsSync(path)) {
    return null;
  }

  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${path} must be a regular file.`);
  }

  return readFileSync(path, 'utf8');
}

function parseComposer(source, label) {
  if (source === null) {
    throw new Error(`${label} is missing composer.json.`);
  }

  let composer;
  try {
    composer = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} has invalid composer.json: ${error.message}`);
  }

  if (composer === null || Array.isArray(composer) || typeof composer !== 'object') {
    throw new Error(`${label} composer.json must contain an object.`);
  }

  return composer;
}

function localRunnerPaths(command) {
  const commands = Array.isArray(command) ? command : [command];
  const paths = new Set();

  for (const value of commands) {
    if (typeof value !== 'string') {
      continue;
    }

    const matches = value.matchAll(/(?:^|[\s"'=;&|()<>])((?:\.\/)?(?:bin|scripts)\/[^\s"';&|()<>]*)(?=$|[\s"';&|()<>])/gu);
    for (const match of matches) {
      const normalized = match[1].startsWith('./') ? match[1].slice(2) : match[1];
      if (!/^(?:bin|scripts)\/[A-Za-z0-9._/-]+$/u.test(normalized)) {
        throw new Error(`Unsupported local runner reference: ${match[1]}.`);
      }
      const segments = normalized.split('/');
      if (segments.includes('') || segments.includes('.') || segments.includes('..')) {
        throw new Error(`Unsupported local runner reference: ${match[1]}.`);
      }
      paths.add(normalized);
    }
  }

  return paths;
}

function analyzerCommands(baseComposer, headComposer, script, baselinePath) {
  const commands = [];
  const pending = [script];
  const visited = new Set();

  while (pending.length > 0) {
    const name = pending.pop();
    if (visited.has(name)) {
      continue;
    }
    visited.add(name);

    const baseCommand = baseComposer.scripts?.[name];
    const headCommand = headComposer.scripts?.[name];
    const valid = typeof baseCommand === 'string'
      || (Array.isArray(baseCommand) && baseCommand.length > 0 && baseCommand.every((value) => typeof value === 'string'));

    if (!valid || JSON.stringify(baseCommand) !== JSON.stringify(headCommand)) {
      throw new Error(`${baselinePath}: Composer script ${name} must exist and remain unchanged.`);
    }

    commands.push(baseCommand);
    for (const command of Array.isArray(baseCommand) ? baseCommand : [baseCommand]) {
      for (const match of command.matchAll(/(?:^|[\s"';&|()<>])@([A-Za-z0-9:_-]+)(?=$|[\s"';&|()<>])/gu)) {
        if (Object.hasOwn(baseComposer.scripts ?? {}, match[1])) {
          pending.push(match[1]);
        }
      }
    }
  }

  return commands;
}

function assertSameFileAtHead(baseRevision, path, context) {
  const base = readAtRevision(baseRevision, path);
  const head = readHead(path);
  if (base !== head) {
    throw new Error(`${context} may not add, remove, or change ${path} while an existing baseline is enforced.`);
  }
}

function compareDottedVersions(left, right) {
  const normalizePart = (part) => part.replace(/^0+/u, '') || '0';
  const leftParts = left.split('.').map(normalizePart);
  const rightParts = right.split('.').map(normalizePart);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? '0';
    const rightPart = rightParts[index] ?? '0';
    if (leftPart.length !== rightPart.length) return leftPart.length - rightPart.length;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }

  return 0;
}

function maskXmlNonElements(source) {
  const visible = source.split('');
  const mask = (start, end) => visible.fill(' ', start, end);
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf('<', index);
    if (start === -1) break;

    if (source.startsWith('<!--', start)) {
      const close = source.indexOf('-->', start + 4);
      if (close === -1) return null;
      const end = close + 3;
      mask(start, end);
      index = end;
      continue;
    }

    if (source.startsWith('<![CDATA[', start)) {
      const close = source.indexOf(']]>', start + 9);
      if (close === -1) return null;
      const end = close + 3;
      mask(start, end);
      index = end;
      continue;
    }

    if (source.startsWith('<?', start)) {
      const close = source.indexOf('?>', start + 2);
      if (close === -1) return null;
      const end = close + 2;
      mask(start, end);
      index = end;
      continue;
    }

    if (source.startsWith('<!', start)) {
      let bracketDepth = 0;
      let quote = null;
      let end = -1;

      for (let cursor = start + 2; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (quote !== null) {
          if (character === quote) quote = null;
          continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === '[') bracketDepth += 1;
        else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1);
        else if (character === '>' && bracketDepth === 0) {
          end = cursor + 1;
          break;
        }
      }

      if (end === -1) return null;
      mask(start, end);
      index = end;
      continue;
    }

    index = start + 1;
  }

  return visible.join('');
}

function openingTagHasNamespaceDeclaration(tag, openingName) {
  const attributePattern = /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"[^"]*"|'[^']*')/gyu;
  attributePattern.lastIndex = `<${openingName}`.length;

  while (!/^\s*\/?\s*>$/u.test(tag.slice(attributePattern.lastIndex))) {
    const attribute = attributePattern.exec(tag);
    if (attribute === null) return null;
    if (attribute[1] === 'xmlns' || attribute[1].startsWith('xmlns:')) return true;
  }

  return false;
}

function directRulesetConfigStarts(source) {
  const name = '[A-Za-z_:][A-Za-z0-9_.:-]*';
  const attribute = `(?:\\s+${name}\\s*=\\s*(?:"[^"]*"|'[^']*'))`;
  const tagPattern = new RegExp(`<\\/(${name})\\s*>|<(${name})${attribute}*\\s*\\/?>`, 'dgyu');
  const starts = new Set();
  const stack = [];
  let cursor = 0;
  let rootSeen = false;

  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start === -1) break;

    tagPattern.lastIndex = start;
    const tag = tagPattern.exec(source);
    if (tag === null) return null;

    const closingName = tag[1];
    const openingName = tag[2];
    if (closingName !== undefined) {
      if (stack.pop() !== closingName) return null;
    } else {
      const directConfig = stack.length === 1 && stack[0] === 'ruleset' && openingName === 'config';
      if (stack.length === 0 || directConfig) {
        const hasNamespaceDeclaration = openingTagHasNamespaceDeclaration(tag[0], openingName);
        if (hasNamespaceDeclaration !== false) return null;
      }

      if (stack.length === 0) {
        if (rootSeen || openingName !== 'ruleset') return null;
        rootSeen = true;
      } else if (directConfig) {
        starts.add(start);
      }

      if (!tag[0].endsWith('/>')) stack.push(openingName);
    }

    cursor = tagPattern.lastIndex;
  }

  return rootSeen && stack.length === 0 ? starts : null;
}

function wordPressMinimumConfig(source) {
  if (source === null) return null;

  const visibleSource = maskXmlNonElements(source);
  if (visibleSource === null) return null;
  const directConfigStarts = directRulesetConfigStarts(visibleSource);
  if (directConfigStarts === null) return null;

  const openingConfigPattern = /^<config\b(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/u;
  const configPattern = /<config\b(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(?:\/>|>\s*<\/config\s*>)/gu;
  const attributePattern = /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/dgyu;
  const parsedConfigStarts = new Set();
  const settings = [];

  for (const config of visibleSource.matchAll(configPattern)) {
    if (!directConfigStarts.has(config.index)) continue;
    parsedConfigStarts.add(config.index);
    const attributes = new Map();
    let duplicate = false;
    const openingTag = openingConfigPattern.exec(config[0])?.[0];
    if (openingTag === undefined) continue;
    attributePattern.lastIndex = '<config'.length;

    while (!/^\s*\/?\s*>$/u.test(openingTag.slice(attributePattern.lastIndex))) {
      const attribute = attributePattern.exec(openingTag);
      if (attribute === null) {
        duplicate = true;
        break;
      }

      const [, name, doubleQuoted, singleQuoted] = attribute;
      if (attributes.has(name)) {
        duplicate = true;
        break;
      }

      const valueGroup = doubleQuoted === undefined ? 3 : 2;
      const [start, end] = attribute.indices[valueGroup];
      attributes.set(name, {
        end: config.index + end,
        start: config.index + start,
        value: attribute[valueGroup],
      });
    }

    if (duplicate) return null;
    if (attributes.get('name')?.value === 'minimum_supported_wp_version') {
      settings.push(attributes.get('value'));
    }
  }

  if (parsedConfigStarts.size !== directConfigStarts.size || settings.length !== 1) return null;
  const [setting] = settings;
  return setting !== undefined && /^[0-9]+(?:\.[0-9]+)*$/u.test(setting.value) ? setting : null;
}

function isMonotonicWordPressMinimumChange(base, head) {
  const baseConfig = wordPressMinimumConfig(base);
  const headConfig = wordPressMinimumConfig(head);
  if (baseConfig === null || headConfig === null) return false;

  const normalize = (source, config) => `${source.slice(0, config.start)}__VERSION__${source.slice(config.end)}`;
  return normalize(base, baseConfig) === normalize(head, headConfig)
    && compareDottedVersions(headConfig.value, baseConfig.value) > 0;
}

function phpstanLevel(source) {
  if (source === null || source.includes('\r')) return null;
  const matches = [...source.matchAll(/^[ \t]+level: ([0-9]+)$/gmu)];
  if (matches.length !== 1) return null;
  const level = Number(matches[0][1]);
  return Number.isSafeInteger(level) && level <= 10 ? level : null;
}

function isClearedPhpstanBaselineMigration(base, head) {
  const baseLevel = phpstanLevel(base);
  const headLevel = phpstanLevel(head);
  if (baseLevel === null || headLevel === null || headLevel <= baseLevel) return false;

  const baselineInclude = /^includes:\n[ \t]+- phpstan-baseline\.neon\n\n/u;
  if (!baselineInclude.test(base) || head.includes('phpstan-baseline.neon') || head.includes('ignoreErrors')) {
    return false;
  }

  // Permit only the WordPress compatibility stub used by the level-7 migration.
  // The following quality step still runs the unchanged Composer analyzer command.
  const stubInclude = '    stubFiles:\n        - phpstan-wordpress-compat.stub\n';
  let normalizedHead = head;
  if (!base.includes('stubFiles:') && head.includes(stubInclude)) {
    if (readHead('phpstan-wordpress-compat.stub') === null) return false;
    normalizedHead = head.replace(stubInclude, '');
  }

  const normalizeLevel = (source) => source.replace(/^([ \t]+level: )[0-9]+$/mu, '$1__LEVEL__');
  return normalizeLevel(base.replace(baselineInclude, '')) === normalizeLevel(normalizedHead);
}

function protectIntroducedAnalyzerContract(baselinePath, centralPhpcs = false) {
  if (baselinePath === 'phpcs-baseline.json' && centralPhpcs) return;
  const contract = ANALYZER_CONTRACTS[baselinePath];
  const composer = parseComposer(readHead('composer.json'), baselinePath);
  const commands = analyzerCommands(composer, composer, contract.script, baselinePath);
  const configurations = contract.configurations.filter((path) => readHead(path) !== null);
  if (configurations.length === 0) {
    throw new Error(`${baselinePath}: head revision has no conventional ${contract.script} configuration.`);
  }

  let analyzerReference = false;
  let baselineReference = configurations.some((path) => readHead(path).includes(baselinePath));
  for (const command of commands) {
    for (const value of Array.isArray(command) ? command : [command]) {
      if (new RegExp(`^\\s*(?:\\./)?(?:vendor/bin/)?${contract.script}(?=$|[\\s;&|()<>])`, 'u').test(value)) {
        analyzerReference = true;
      }
    }

    for (const path of localRunnerPaths(command)) {
      const source = readHead(path);
      if (source === null) {
        throw new Error(`${baselinePath}: Composer script references missing head runner ${path}.`);
      }
      if (source.includes(`vendor/bin/${contract.script}`)) {
        analyzerReference = true;
      }
      if (source.includes(baselinePath)) {
        baselineReference = true;
      }
    }
  }

  if (!analyzerReference) {
    throw new Error(`${baselinePath}: Composer script ${contract.script} does not directly reference the analyzer or a runner with its locked vendor binary.`);
  }
  if (!baselineReference) {
    throw new Error(`${baselinePath}: no conventional configuration or direct runner references the introduced baseline.`);
  }
}

function protectAnalyzerContract(baseRevision, baselinePath, centralPhpcs = false, baselineRemoved = false) {
  if (baselinePath === 'phpcs-baseline.json' && centralPhpcs) return;
  const contract = ANALYZER_CONTRACTS[baselinePath];
  const baseComposer = parseComposer(readAtRevision(baseRevision, 'composer.json'), baselinePath);
  const headComposer = parseComposer(readHead('composer.json'), baselinePath);
  const commands = analyzerCommands(baseComposer, headComposer, contract.script, baselinePath);

  const baseConfigurations = contract.configurations.filter((path) => readAtRevision(baseRevision, path) !== null);
  const headConfigurations = contract.configurations.filter((path) => readHead(path) !== null);
  if (baseConfigurations.length === 0) {
    throw new Error(`${baselinePath}: base revision has no conventional ${contract.script} configuration.`);
  }

  let phpcsMinimumChangeUsed = false;
  for (const path of contract.configurations) {
    if (baselinePath === 'phpstan-baseline.neon'
      && baselineRemoved
      && baseConfigurations.length === 1
      && headConfigurations.length === 1
      && baseConfigurations[0] === path
      && headConfigurations[0] === path
      && isClearedPhpstanBaselineMigration(readAtRevision(baseRevision, path), readHead(path))) {
      continue;
    }
    if (baselinePath === 'phpcs-baseline.json'
      && isMonotonicWordPressMinimumChange(readAtRevision(baseRevision, path), readHead(path))) {
      if (baseConfigurations.length !== 1
        || headConfigurations.length !== 1
        || baseConfigurations[0] !== path
        || headConfigurations[0] !== path) {
        throw new Error(`${baselinePath} may raise minimum_supported_wp_version only when exactly one conventional configuration is present.`);
      }
      if (phpcsMinimumChangeUsed) {
        throw new Error(`${baselinePath} may raise minimum_supported_wp_version in only one conventional configuration per pull request.`);
      }
      phpcsMinimumChangeUsed = true;
      continue;
    }
    assertSameFileAtHead(baseRevision, path, baselinePath);
  }

  for (const command of commands) {
    for (const path of localRunnerPaths(command)) {
      if (readAtRevision(baseRevision, path) === null) {
        throw new Error(`${baselinePath}: Composer script references missing base runner ${path}.`);
      }
      assertSameFileAtHead(baseRevision, path, baselinePath);
    }
  }
}

export function checkBaselines(baseRevision, { centralPhpcs = false } = {}) {
  try {
    execFileSync('git', ['cat-file', '-e', `${baseRevision}^{commit}`], {
      stdio: 'ignore',
    });
  } catch {
    throw new Error(`Base revision ${baseRevision} is not an available commit.`);
  }

  const failures = [];

  for (const [path, parse] of Object.entries(BASELINE_FILES)) {
    const baseSource = readAtRevision(baseRevision, path);
    const headSource = readHead(path);

    // Introducing a baseline is allowed. Once it exists on the base revision,
    // every added allowance and count increase must fail the pull request.
    if (baseSource === null) {
      if (headSource !== null) {
        protectIntroducedAnalyzerContract(path, centralPhpcs);
        parse(headSource, path);
        console.log(`${path}: initial baseline introduction permitted.`);
      }
      continue;
    }

    protectAnalyzerContract(baseRevision, path, centralPhpcs, headSource === null);

    const base = parse(baseSource, `${path} at ${baseRevision}`);
    const head = headSource === null ? new Map() : parse(headSource, path);
    const fileFailures = compareAllowances(base, head, path);
    failures.push(...fileFailures);

    if (fileFailures.length === 0) {
      console.log(`${path}: allowances did not grow (${head.size} current, ${base.size} on base).`);
    }
  }

  return failures;
}

function main(argv) {
  const [baseRevision, ...extra] = argv;
  const centralPhpcs = extra.length === 1 && extra[0] === '--central-phpcs';
  if (!baseRevision || (!centralPhpcs && extra.length > 0) || extra.length > 1 || !/^[0-9a-f]{40}$/u.test(baseRevision)) {
    console.error('Usage: check-static-analysis-baselines.mjs <40-character-base-commit> [--central-phpcs]');
    return 2;
  }

  try {
    const failures = checkBaselines(baseRevision, { centralPhpcs });
    if (failures.length > 0) {
      console.error('Static-analysis baselines may not grow in a pull request:');
      failures.forEach((failure) => console.error(`- ${failure}`));
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
