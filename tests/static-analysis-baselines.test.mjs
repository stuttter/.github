import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareAllowances,
  parsePhpcsBaseline,
  parsePhpstanBaseline,
} from '../scripts/check-static-analysis-baselines.mjs';

test('PHPCS baseline reports new keys and count increases exactly', () => {
  const base = parsePhpcsBaseline(JSON.stringify({
    'includes/a.php|Example.Sniff.One': 2,
    'includes/b.php|Example.Sniff.Two': 3,
  }));
  const head = parsePhpcsBaseline(JSON.stringify({
    'includes/a.php|Example.Sniff.One': 4,
    'includes/c.php|Example.Sniff.Three': 1,
  }));

  assert.deepEqual(compareAllowances(base, head, 'phpcs-baseline.json'), [
    'phpcs-baseline.json: includes/a.php|Example.Sniff.One increased from 2 to 4.',
    'phpcs-baseline.json: includes/c.php|Example.Sniff.Three is a new allowance key with count 1.',
  ]);
});

test('PHPCS baseline rejects a new key even when its count is zero', () => {
  const base = parsePhpcsBaseline('{"existing":0}');
  const head = parsePhpcsBaseline('{"existing":0,"new":0}');
  assert.deepEqual(compareAllowances(base, head, 'phpcs-baseline.json'), [
    'phpcs-baseline.json: new is a new allowance key with count 0.',
  ]);
});

test('PHPCS baseline permits removed keys and lower counts', () => {
  const base = parsePhpcsBaseline('{"one":3,"two":2}');
  const head = parsePhpcsBaseline('{"one":1}');
  assert.deepEqual(compareAllowances(base, head, 'phpcs-baseline.json'), []);
});

test('PHPCS baseline rejects malformed allowance counts', () => {
  assert.throws(
    () => parsePhpcsBaseline('{"one":"2"}'),
    /one must be a non-negative integer/u,
  );
});

test('PHPStan baseline compares generated entries independently of property order', () => {
  const base = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Narrow message$#'
      identifier: argument.type
      count: 2
      path: includes/file.php
`);
  const head = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      path: includes/file.php
      count: 1
      identifier: argument.type
      message: '#^Narrow message$#'
`);

  assert.deepEqual(compareAllowances(base, head, 'phpstan-baseline.neon'), []);
});

test('PHPStan baseline rejects increased counts and broader replacement patterns', () => {
  const base = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Narrow message$#'
      identifier: argument.type
      count: 2
      path: includes/file.php
`);
  const head = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#.*#'
      identifier: argument.type
      count: 3
      path: includes/file.php
`);
  const failures = compareAllowances(base, head, 'phpstan-baseline.neon');

  assert.equal(failures.length, 1);
  assert.match(failures[0], /#\.\*#.*not provably narrower/u);
});

test('PHPStan permits only canonical literal-prefix narrowing with bounded total count', () => {
  const base = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known problem.*$#'
      count: 3
      path: includes/file.php
`);
  const head = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known problem for Foo\\(\\)\\.$#'
      identifier: argument.type
      count: 1
      path: includes/file.php
    -
      message: '#^Known problem for Bar.*$#'
      count: 2
      path: includes/file.php
`);
  assert.deepEqual(compareAllowances(base, head, 'phpstan-baseline.neon'), []);
});

test('PHPStan narrowing recognizes PHPStan-generated escaped punctuation as literal text', () => {
  const base = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Method Example\\:\\:run\\(\\) reports \\$value.*$#'
      count: 1
      path: includes/file.php
`);
  const head = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Method Example\\:\\:run\\(\\) reports \\$value exactly\\.$#'
      count: 1
      path: includes/file.php
`);
  assert.deepEqual(compareAllowances(base, head, 'phpstan-baseline.neon'), []);
});

test('PHPStan narrowing rejects unsafe regex syntax, changed paths, excess counts, and ambiguous parents', () => {
  const base = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known .*problem.*$#'
      count: 2
      path: includes/file.php
    -
      message: '#^Known problem.*$#'
      count: 1
      path: includes/file.php
`);

  for (const [message, path, count, expected] of [
    ["'#^Known specific problem$#'", 'includes/file.php', 1, /not provably narrower/u],
    ["'#^Known problem in Foo$#'", 'includes/other.php', 1, /not provably narrower/u],
    ["'#^Known problem in Foo$#'", 'includes/file.php', 2, /not provably narrower/u],
  ]) {
    const head = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: ${message}
      count: ${count}
      path: ${path}
`);
    assert.match(compareAllowances(base, head, 'phpstan-baseline.neon').join('\n'), expected);
  }

  const ambiguousBase = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known.*$#'
      count: 1
      path: includes/file.php
    -
      message: '#^Known problem.*$#'
      count: 1
      path: includes/file.php
`);
  const narrowed = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known problem here$#'
      count: 1
      path: includes/file.php
`);
  assert.match(compareAllowances(ambiguousBase, narrowed, 'phpstan-baseline.neon').join('\n'), /ambiguous/u);
});

test('PHPStan narrowing cannot broaden a prefix or remove or change an identifier', () => {
  const base = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known problem.*$#'
      identifier: argument.type
      count: 1
      path: includes/file.php
`);

  for (const [message, identifier] of [
    ["'#^Known.*$#'", 'argument.type'],
    ["'#^Known problem here$#'", null],
    ["'#^Known problem here$#'", 'return.type'],
  ]) {
    const head = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: ${message}
${identifier === null ? '' : `      identifier: ${identifier}\n`}      count: 1
      path: includes/file.php
`);
    assert.match(compareAllowances(base, head, 'phpstan-baseline.neon').join('\n'), /not provably narrower/u);
  }
});

test('PHPStan narrowing rejects the undocumented unanchored wildcard form', () => {
  const base = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known#'
      count: 1
      path: includes/file.php
`);
  const head = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known problem.*#'
      count: 1
      path: includes/file.php
`);
  assert.match(compareAllowances(base, head, 'phpstan-baseline.neon').join('\n'), /not provably narrower/u);
});

test('PHPStan baseline rejects an entry without an explicit count', () => {
  assert.throws(() => parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known message$#'
      path: includes/file.php
`), /must have an explicit positive count/u);
});

test('PHPStan baseline rejects zero and negative counts', () => {
  for (const count of ['0', '-1']) {
    assert.throws(() => parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known message$#'
      count: ${count}
      path: includes/file.php
`), /must have a positive count/u);
  }
});

test('PHPStan baseline rejects inline entries', () => {
  assert.throws(() => parsePhpstanBaseline(`parameters:
  ignoreErrors:
    - '#^Known message$#'
`), /inline ignoreErrors entries are not permitted/u);
});

test('PHPStan baseline rejects inline ignoreErrors collections', () => {
  assert.throws(
    () => parsePhpstanBaseline("parameters:\n  ignoreErrors: [ '#.*#' ]\n"),
    /must contain one canonical parameters\.ignoreErrors block/u,
  );
});

test('PHPStan baseline rejects includes and missing canonical markers', () => {
  assert.throws(
    () => parsePhpstanBaseline("includes:\n  - permissive.neon\n"),
    /must begin with a canonical parameters block/u,
  );
  assert.throws(
    () => parsePhpstanBaseline("parameters:\n  level: 5\n"),
    /must contain one canonical parameters\.ignoreErrors block/u,
  );
});

test('PHPStan baseline rejects trailing content and multiple blocks', () => {
  const entry = `parameters:
  ignoreErrors:
    -
      message: '#^Known message$#'
      count: 1
      path: includes/file.php
`;

  assert.throws(
    () => parsePhpstanBaseline(`${entry}includes:\n  - permissive.neon\n`),
    /unsupported content outside parameters\.ignoreErrors/u,
  );
  assert.throws(
    () => parsePhpstanBaseline(`${entry}parameters:\n  ignoreErrors:\n    - '#.*#'\n`),
    /unsupported content outside parameters\.ignoreErrors/u,
  );
});

test('PHPStan baseline fails closed on unsupported multiline values', () => {
  assert.throws(
    () => parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: '#^Known message$#'
      paths:
        - includes/one.php
        - includes/two.php
`),
    /unsupported multiline value/u,
  );
});

test('PHPStan baseline requires string scalars instead of NEON collections or typed values', () => {
  for (const [property, value] of [
    ['message', '[]'],
    ['message', '{ pattern: broad }'],
    ['message', '|'],
    ['path', '[includes/file.php]'],
    ['path', 'true'],
    ['identifier', '42'],
  ]) {
    const properties = {
      message: "'#^Known message$#'",
      count: '1',
      path: 'includes/file.php',
      [property]: value,
    };
    const source = `parameters:
  ignoreErrors:
    -
      message: ${properties.message}
      ${property === 'identifier' ? `identifier: ${properties.identifier}\n      ` : ''}count: ${properties.count}
      path: ${properties.path}
`;
    assert.throws(() => parsePhpstanBaseline(source), /string scalar/u);
  }
});

test('PHPStan baseline rejects empty entries', () => {
  assert.throws(
    () => parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
`),
    /final ignoreErrors entry is empty/u,
  );
});

test('PHPStan allowance keys cannot collide through scalar delimiters', () => {
  const left = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: 'first|path:second'
      count: 1
      path: third
`);
  const right = parsePhpstanBaseline(`parameters:
  ignoreErrors:
    -
      message: 'first'
      count: 1
      path: 'second|path:third'
`);

  assert.notEqual([...left.keys()][0], [...right.keys()][0]);
});
