import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const validator = fileURLToPath(new URL('../scripts/validate-plugin.php', import.meta.url));

function fixture(shortDescription, { emptyOptionalHeader = false, emptyStableTag = false, headersAfterDescription = false, omitDescriptionHeading = false, trailingHeader = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-metadata-'));
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github/plugin-standard.json'), `${JSON.stringify({
    slug: 'example-plugin',
    main_file: 'example-plugin.php',
    risk: 'standard',
    minimum_php: '7.4',
    minimum_wordpress: '6.4',
    tested_wordpress: '7.1',
    wordpress_org: true,
    multisite: false,
  })}\n`);
  writeFileSync(join(root, 'example-plugin.php'), `<?php
/*
 * Plugin Name: Example Plugin
 * Version: 1.0.0
 * Requires PHP: 7.4
 * Text Domain: example-plugin
 */
`);
  const shortDescriptionBlock = null === shortDescription ? '' : `\n${shortDescription}\n${trailingHeader ? 'License: GPLv2 or later\n' : ''}`;
  const headers = `Requires at least: 6.4
${emptyOptionalHeader ? 'Donate link:\n' : ''}Tested up to: 7.1
Requires PHP: 7.4
Stable tag: ${emptyStableTag ? '' : '1.0.0'}
`;
  writeFileSync(join(root, 'readme.txt'), `=== Example Plugin ===
${headersAfterDescription ? '' : headers}
${shortDescriptionBlock}
${omitDescriptionHeading ? '' : '== Description =='}

${headersAfterDescription ? headers : ''}
Long description.

== Changelog ==

= 1.0.0 =
* Initial release
`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function validate(root, expectedVersion = '1.0.0') {
  const args = null === expectedVersion ? [validator, root] : [validator, root, expectedVersion];
  return spawnSync('php', args, { encoding: 'utf8' });
}

test('accepts plain-text WordPress.org short descriptions', () => {
  for (const [description, options] of [
    ['Compare 2 < 3 > 1, multiply 2 * 3 * 4, and export wp_options.', {}],
    ['Use _wp_options safely.', {}],
    ['Use foo__bar__ safely.', {}],
    ['See https://example.com/_path_ for details.', {}],
    ['A concise description.', { emptyOptionalHeader: true }],
  ]) {
    const { root, cleanup } = fixture(description, options);
    try {
      const result = validate(root);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Plugin metadata is consistent/u);
    } finally {
      cleanup();
    }
  }
});

test('rejects a missing WordPress.org short description', () => {
  const { root, cleanup } = fixture(null);
  try {
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly one plain-text short description/u);
  } finally {
    cleanup();
  }
});

test('rejects a Unicode-whitespace-only WordPress.org short description', () => {
  const { root, cleanup } = fixture('\u00a0');
  try {
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly one plain-text short description/u);
  } finally {
    cleanup();
  }
});

test('rejects an overlong WordPress.org short description', () => {
  const { root, cleanup } = fixture('a'.repeat(151));
  try {
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no more than 150 characters/u);
  } finally {
    cleanup();
  }
});

test('rejects markup in a WordPress.org short description', () => {
  const { root, cleanup } = fixture('A **formatted** description.');
  try {
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not contain markup/u);
  } finally {
    cleanup();
  }
});

test('rejects block markup in a WordPress.org short description', () => {
  for (const description of ['# Heading', '#', '##', '   # Heading', '- list item', '  - list item', '1. list item', '[label]: https://example.com', '---', '* * *', '```', '   ``` ', '~~~php']) {
    const { root, cleanup } = fixture(description);
    try {
      const result = validate(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must not contain markup/u);
    } finally {
      cleanup();
    }
  }
});

test('rejects HTML comments, reference links, and strikethrough markup', () => {
  for (const description of [
    'Visible <!-- hidden --> description.',
    'Visible <!-- hidden description.',
    'Visible <!doctype html> description.',
    'Use <?php for examples.',
    'A [linked description][docs].',
    'An ![](https://example.com/image.png) image.',
    'An [empty destination]() link.',
    'See [a\\]b](https://example.com).',
    'A ~~deprecated~~ description.',
    'A *formatted*description.',
    'Use foo*bar* here.',
    'Use _wp_options_ here.',
    'Use __foo_bar__ here.',
    'Use ``foo`` here.',
  ]) {
    const { root, cleanup } = fixture(description);
    try {
      const result = validate(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must not contain markup/u);
    } finally {
      cleanup();
    }
  }
});

test('rejects a header placed after the WordPress.org short description', () => {
  const { root, cleanup } = fixture('A concise description.', { trailingHeader: true });
  try {
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly one plain-text short description/u);
  } finally {
    cleanup();
  }
});

test('rejects an indented-code WordPress.org short description', () => {
  for (const description of ['    code', '\tcode', ' \tcode', '   \tcode']) {
    const { root, cleanup } = fixture(description);
    try {
      const result = validate(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must not contain markup/u);
    } finally {
      cleanup();
    }
  }
});

test('rejects required headers placed after the Description heading', () => {
  const { root, cleanup } = fixture('A concise description.', { headersAfterDescription: true });
  try {
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /required metadata headers must precede/u);
  } finally {
    cleanup();
  }
});

test('rejects a missing Description heading without parser warnings', () => {
  const { root, cleanup } = fixture('A concise description.', { omitDescriptionHeading: true });
  try {
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing the == Description == heading/u);
    assert.doesNotMatch(result.stderr, /undefined variable/iu);
  } finally {
    cleanup();
  }
});

test('rejects an empty Stable tag without an expected release version', () => {
  const { root, cleanup } = fixture('A concise description.', { emptyStableTag: true });
  try {
    const result = validate(root, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /required metadata headers must precede/u);
  } finally {
    cleanup();
  }
});

test('rejects a Short Description heading in place of the required line', () => {
  const { root, cleanup } = fixture('== Short Description ==');
  try {
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not contain markup/u);
  } finally {
    cleanup();
  }
});
