#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rubyParser = String.raw`
  require 'json'
  require 'yaml'
  document = YAML.safe_load(File.read(ARGV.fetch(0)), permitted_classes: [], permitted_symbols: [], aliases: false)
  references = []
  walk = lambda do |value|
    case value
    when Hash
      value.each do |key, child|
        if key.to_s == 'uses'
          raise TypeError, 'uses value must be a string' unless child.is_a?(String)
          references << child
        end
        walk.call(child)
      end
    when Array
      value.each { |child| walk.call(child) }
    end
  end
  walk.call(document)
  print JSON.generate(references)
`;

function workflowFiles(root, relativePath) {
  const absolute = resolve(root, relativePath);
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && ['.yml', '.yaml'].includes(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
}

export function validateWorkflowPins(root, directories) {
  const errors = [];
  for (const directory of directories) {
    for (const path of workflowFiles(root, directory)) {
      const displayPath = relative(root, path);
      const parsed = spawnSync('ruby', ['-e', rubyParser, path], { encoding: 'utf8' });
      if (parsed.status !== 0) {
        errors.push(`${displayPath}: cannot safely parse workflow uses references: ${parsed.stderr.trim()}`);
        continue;
      }
      for (const reference of JSON.parse(parsed.stdout)) {
        if (reference.startsWith('./')) continue;
        if (reference.startsWith('docker://')) {
          if (!/^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(reference)) {
            errors.push(`${displayPath}: Docker action is not pinned to a sha256 image digest: ${reference}`);
          }
          continue;
        }
        if (displayPath.startsWith('fleet/templates/') && reference.endsWith('@{{policy_ref}}')) continue;
        const pinned = reference.match(/@([0-9a-f]{40})$/);
        if (!pinned) {
          errors.push(`${displayPath}: remote workflow/action is not pinned to a full commit SHA: ${reference}`);
        } else if (displayPath.startsWith('.github/workflows/') && /^0{40}$/.test(pinned[1])) {
          errors.push(`${displayPath}: active workflow uses the fail-closed example SHA.`);
        }
      }
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directories = process.argv.slice(2);
  if (directories.length === 0) {
    process.stderr.write('Provide one or more workflow directories.\n');
    process.exitCode = 2;
  } else {
    const errors = validateWorkflowPins(repositoryRoot, directories);
    if (errors.length) {
      process.stderr.write(`${errors.join('\n')}\n`);
      process.exitCode = 1;
    }
  }
}
