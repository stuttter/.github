import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { patchWordPressEnvSimpleGit } from '../scripts/patch-wordpress-env.mjs';

const source = `before
const SimpleGit = require( 'simple-git' );
after
`;
const hash = createHash('sha256').update(source).digest('hex');

test('wp-env patch uses the simple-git 4 named CommonJS export', () => {
  const patched = patchWordPressEnvSimpleGit(source, hash);

  assert.match(patched, /const \{ simpleGit: SimpleGit \} = require\( 'simple-git' \);/u);
  assert.doesNotMatch(patched, /const SimpleGit = require/u);
});

test('wp-env patch rejects source drift and repeated import anchors', () => {
  assert.throws(
    () => patchWordPressEnvSimpleGit(`${source}drift`, hash),
    /unexpected @wordpress\/env source/u,
  );
  const repeated = `${source}${source}`;
  const repeatedHash = createHash('sha256').update(repeated).digest('hex');
  assert.throws(
    () => patchWordPressEnvSimpleGit(repeated, repeatedHash),
    /unexpected number of times/u,
  );
});
