import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const pluginSchema = readJson('schema/plugin-standard.schema.json');
const portfolioSchema = readJson('schema/portfolio.schema.json');
const portfolio = readJson('portfolio/plugins.json');
const schemas = new Map([
  [pluginSchema.$id, pluginSchema],
  [portfolioSchema.$id, portfolioSchema],
]);

function validate(instance, schema, path = '$', base = schema.$id) {
  if (schema.$ref) {
    const reference = new URL(schema.$ref, base).href;
    const referenced = schemas.get(reference);
    assert.ok(referenced, `Unresolved schema reference: ${reference}`);
    return validate(instance, referenced, path, referenced.$id);
  }

  const errors = [];
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((nested) => validate(instance, nested, path, base).length === 0);
    if (matches.length !== 1) return [`${path} must match exactly one allowed schema.`];
  }
  for (const nested of schema.allOf || []) errors.push(...validate(instance, nested, path, base));
  if (schema.if && validate(instance, schema.if, path, base).length === 0 && schema.then) errors.push(...validate(instance, schema.then, path, base));
  const actualType = Array.isArray(instance) ? 'array' : instance === null ? 'null' : typeof instance;
  if (schema.type && actualType !== schema.type) return [`${path} must be ${schema.type}.`];
  if ('const' in schema && instance !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}.`);
  if (schema.enum && !schema.enum.includes(instance)) errors.push(`${path} is not an allowed value.`);
  if (schema.minLength && typeof instance === 'string' && instance.length < schema.minLength) errors.push(`${path} is too short.`);
  if (schema.pattern && typeof instance === 'string' && !new RegExp(schema.pattern).test(instance)) errors.push(`${path} does not match ${schema.pattern}.`);
  if (schema.format === 'uri-reference' && typeof instance === 'string') {
    try {
      new URL(instance, 'https://schema.invalid/');
    } catch {
      errors.push(`${path} is not a URI reference.`);
    }
  }

  if (schema.type === 'object' || schema.properties || schema.required) {
    if (schema.minProperties && Object.keys(instance).length < schema.minProperties) errors.push(`${path} needs at least ${schema.minProperties} property/properties.`);
    for (const required of schema.required || []) if (!(required in instance)) errors.push(`${path} is missing ${required}.`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(instance)) if (!(key in (schema.properties || {}))) errors.push(`${path}.${key} is not allowed.`);
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, value] of Object.entries(instance)) {
        if (!(key in (schema.properties || {}))) errors.push(...validate(value, schema.additionalProperties, `${path}.${key}`, base));
      }
    }
    if (schema.propertyNames) for (const key of Object.keys(instance)) errors.push(...validate(key, schema.propertyNames, `${path} key`, base));
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (key in instance) errors.push(...validate(instance[key], propertySchema, `${path}.${key}`, base));
    }
  }

  if (Array.isArray(instance)) {
    if (schema.minItems && instance.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} item(s).`);
    if (schema.uniqueItems && new Set(instance.map((item) => JSON.stringify(item))).size !== instance.length) errors.push(`${path} must contain unique items.`);
    if (schema.items) instance.forEach((item, index) => errors.push(...validate(item, schema.items, `${path}[${index}]`, base)));
    if (schema.contains && !instance.some((item, index) => validate(item, schema.contains, `${path}[${index}]`, base).length === 0)) errors.push(`${path} must contain a matching item.`);
  }

  return errors;
}

test('published schema identifiers and references resolve to raw JSON resources', () => {
  assert.match(pluginSchema.$id, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.match(portfolioSchema.$id, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal(new URL(portfolioSchema.properties.repositories.items.properties.manifest.$ref, portfolioSchema.$id).href, pluginSchema.$id);
  assert.equal(portfolio.$schema, portfolioSchema.$id);
});

test('portfolio inventory validates through its schema and referenced plugin schema', () => {
  assert.deepEqual(validate(portfolio, portfolioSchema), []);
});

test('portfolio schema rejects root policy drift and invalid referenced manifests', () => {
  assert.match(validate({ ...portfolio, surprise: true }, portfolioSchema).join('\n'), /surprise is not allowed/);
  assert.match(validate({ ...portfolio, $schema: 42 }, portfolioSchema).join('\n'), /\$\.\$schema must be string/);
  const invalid = structuredClone(portfolio);
  invalid.repositories[0].manifest.slug = 'Invalid Slug';
  assert.match(validate(invalid, portfolioSchema).join('\n'), /slug does not match/);
  const invalidRelease = structuredClone(portfolio);
  invalidRelease.repositories[0].managed_paths = ['release'];
  invalidRelease.repositories[0].manifest.wordpress_org = false;
  assert.match(validate(invalidRelease, portfolioSchema).join('\n'), /must equal true/);
});

test('portfolio schema accepts non-release managed paths for non-WordPress.org repositories', () => {
  const valid = structuredClone(portfolio);
  valid.repositories[0].managed_paths = ['ci'];
  valid.repositories[0].manifest.wordpress_org = false;
  assert.deepEqual(validate(valid, portfolioSchema), []);
});

test('portfolio schema keeps executable project checks centrally bounded', () => {
  const missing = structuredClone(portfolio);
  delete missing.repositories[0].checks;
  assert.match(validate(missing, portfolioSchema).join('\n'), /is missing checks/u);

  const missingPhpunit = structuredClone(portfolio);
  delete missingPhpunit.repositories[0].checks.phpunit;
  assert.match(validate(missingPhpunit, portfolioSchema).join('\n'), /is missing phpunit/u);

  const arbitraryNode = structuredClone(portfolio);
  arbitraryNode.repositories[0].checks.node = { version: '24', script: 'release', scripts: { release: 'true' } };
  assert.match(validate(arbitraryNode, portfolioSchema).join('\n'), /must equal "build:check"/u);

  const unsafeSmoke = structuredClone(portfolio);
  unsafeSmoke.repositories[0].checks.smoke = { single_site: 'tests/../outside.sh', files: [] };
  assert.match(validate(unsafeSmoke, portfolioSchema).join('\n'), /does not match/u);

  const falseMultisite = structuredClone(portfolio);
  falseMultisite.repositories[2].checks.smoke = { multisite: 'tests/integration/run.sh', files: [{ path: 'tests/integration/run.sh', sha256: 'a'.repeat(64) }] };
  assert.match(validate(falseMultisite, portfolioSchema).join('\n'), /must equal true/u);

  const lineBreak = structuredClone(portfolio);
  lineBreak.repositories[0].checks.smoke = { single_site: 'tests/run.sh\n', files: [{ path: 'tests/run.sh', sha256: 'a'.repeat(64) }] };
  assert.match(validate(lineBreak, portfolioSchema).join('\n'), /does not match/u);
});
