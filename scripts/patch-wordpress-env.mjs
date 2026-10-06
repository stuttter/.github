#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const anchor = "const SimpleGit = require( 'simple-git' );";
const replacement = "const { simpleGit: SimpleGit } = require( 'simple-git' );";
const patches = [
  {
    path: 'download-sources.js',
    hash: '24a477b5fe46da57e56fe7928e28936a3762d08859235074ffa8e645d48e5459',
  },
  {
    path: 'runtime/docker/download-wp-phpunit.js',
    hash: '12fbc30ecb29353c8ec35474abe0809ab7f9815753aff2ec31cfdb3669296c1a',
  },
];

export function patchWordPressEnvSimpleGit(source, requiredHash) {
  const actualHash = createHash('sha256').update(source).digest('hex');
  if (actualHash !== requiredHash) {
    throw new Error(`Refusing to patch unexpected @wordpress/env source ${actualHash}.`);
  }
  if (source.split(anchor).length !== 2) {
    throw new Error('The expected @wordpress/env simple-git import occurs an unexpected number of times.');
  }
  return source.replace(anchor, replacement);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) {
      throw new Error('Usage: patch-wordpress-env.mjs PATH_TO_WORDPRESS_ENV_LIB');
    }

    const root = process.argv[2];
    const prepared = patches.map((patch) => {
      const path = resolve(root, patch.path);
      const status = lstatSync(path);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error(`@wordpress/env source must be a regular file: ${patch.path}`);
      }
      return {
        path,
        source: patchWordPressEnvSimpleGit(readFileSync(path, 'utf8'), patch.hash),
      };
    });

    for (const file of prepared) {
      writeFileSync(file.path, file.source, 'utf8');
    }
    process.stdout.write('Applied the audited @wordpress/env simple-git 4 compatibility patch.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
