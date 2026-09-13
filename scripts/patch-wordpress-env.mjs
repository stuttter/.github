#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const expectedHash = 'bc823c4293d6186c317f8a1038738c459df338d32ac590c499d8704bb504d346';
const legacyAnchor = `	// WordPress versions below 5.1 didn't use proper spacing in wp-config.
	const configAnchor =
		wpVersion && isWPMajorMinorVersionLower( wpVersion, '5.1' )
			? \`"define('WP_DEBUG',"\`
			: \`"define( 'WP_DEBUG',"\`;
`;
const dockerAnchor = `	// wp-config.php comes from the current Docker image, not the selected core source.
	const configAnchor = \`"define( 'WP_DEBUG',"\`;
`;

export function patchWordPressEnv(source, requiredHash = expectedHash) {
  const actualHash = createHash('sha256').update(source).digest('hex');
  if (actualHash !== requiredHash) {
    throw new Error(`Refusing to patch unexpected @wordpress/env source ${actualHash}.`);
  }
  if (source.split(legacyAnchor).length !== 2) {
    throw new Error('The expected @wordpress/env configuration anchor occurs an unexpected number of times.');
  }
  return source.replace(legacyAnchor, dockerAnchor);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('Usage: patch-wordpress-env.mjs PATH_TO_WORDPRESS_JS');
    }
    const path = process.argv[2];
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error('@wordpress/env source must be a regular file.');
    }
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, patchWordPressEnv(source), 'utf8');
    process.stdout.write('Applied the audited WordPress 5.0 Docker configuration-anchor compatibility patch.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
