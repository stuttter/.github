import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { patchWordPressEnv } from '../scripts/patch-wordpress-env.mjs';

const source = `before
	// WordPress versions below 5.1 didn't use proper spacing in wp-config.
	const configAnchor =
		wpVersion && isWPMajorMinorVersionLower( wpVersion, '5.1' )
			? \`"define('WP_DEBUG',"\`
			: \`"define( 'WP_DEBUG',"\`;
after
`;
const hash = createHash('sha256').update(source).digest('hex');

test('wp-env patch binds the Docker configuration anchor without changing core', () => {
  const patched = patchWordPressEnv(source, hash);

  assert.match(patched, /wp-config\.php comes from the current Docker image/u);
  assert.match(patched, /const configAnchor = `"define\( 'WP_DEBUG',"`;/u);
  assert.doesNotMatch(patched, /isWPMajorMinorVersionLower\( wpVersion/u);
});

test('wp-env patch rejects source drift and repeated anchor blocks', () => {
  assert.throws(() => patchWordPressEnv(`${source}drift`, hash), /unexpected @wordpress\/env source/u);
  const repeated = `${source}${source}`;
  const repeatedHash = createHash('sha256').update(repeated).digest('hex');
  assert.throws(() => patchWordPressEnv(repeated, repeatedHash), /unexpected number of times/u);
});
