import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateNotes(notes, digest) {
  if (typeof notes !== 'string' || !notes.trim() || notes.includes('\0') || notes.startsWith('\uFEFF')) {
    throw new Error('Exact reviewed release notes are required.');
  }
  const bytes = Buffer.from(notes, 'utf8');
  if (bytes.toString('utf8') !== notes || bytes.length > 60000) {
    throw new Error('Release notes must be valid UTF-8 within the dispatch size limit.');
  }
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)
      || createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error('Release notes do not match the reviewed SHA256.');
  }
  return bytes;
}

export function writeNotes(path, notes, digest) {
  const bytes = validateNotes(notes, digest);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}

export function verifyRelease(release, notes, digest, version) {
  validateNotes(notes, digest);
  if (release?.body !== notes || release?.name !== version || release?.tagName !== version
      || release?.isDraft !== false || release?.isPrerelease !== false) {
    throw new Error('GitHub release metadata does not match the reviewed publication.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, path] = process.argv.slice(2);
    const { RELEASE_NOTES: notes, RELEASE_NOTES_SHA256: digest, VERSION: version } = process.env;
    if (mode === 'validate' && !path) {
      validateNotes(notes, digest);
    } else if (mode === 'write' && path) {
      writeNotes(path, notes, digest);
    } else if (mode === 'verify' && path && version) {
      verifyRelease(JSON.parse(readFileSync(path, 'utf8')), notes, digest, version);
    } else {
      throw new Error('Use validate, write FILE, or verify FILE with VERSION.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
