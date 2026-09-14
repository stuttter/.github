import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const skill = readFileSync(new URL('../.github/skills/code-review/SKILL.md', import.meta.url), 'utf8');

test('code-review skill has valid review-focused frontmatter', () => {
  assert.match(skill, /^---\n# Managed by stuttter\/\.github fleet standards\. Do not edit locally\.\nname: code-review\ndescription: [^\n]+\nlicense: GPL-2\.0-or-later\n---\n/u);
  assert.match(skill, /Use for GitHub Copilot code review\./u);
});

test('code-review skill requires exact-head actionable compatibility review', () => {
  for (const requirement of [
    /exact current head/u,
    /security boundaries/u,
    /backward compatibility/u,
    /atomicity, rollback, idempotency, cleanup/u,
    /tests that exercise the changed behavior/u,
    /deterministic generated assets/u,
    /minimum PHP and WordPress versions/u,
    /Tie each finding to the narrowest relevant changed lines/u,
  ]) assert.match(skill, requirement);

  assert.match(skill, /Avoid style nitpicks,\ngeneric summaries/u);
});

test('code-review skill remains review-only', () => {
  assert.match(skill, /grants review authority only/u);
  assert.match(skill, /Never push commits, approve or merge a\npull request, enable auto-merge, change repository settings, tag a version, or\npublish/u);
});
