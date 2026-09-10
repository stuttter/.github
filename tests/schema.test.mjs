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
  for (const nested of schema.allOf || []) errors.push(...validate(instance, nested, path, base));
  if (schema.if && validate(instance, schema.if, path, base).length === 0 && schema.then) errors.push(...validate(instance, schema.then, path, base));
  const actualType = Array.isArray(instance) ? 'array' : instance === null ? 'null' : typeof instance;
  if (schema.type && actualType !== schema.type) return [`${path} must be ${schema.type}.`];
  if ('const' in schema && instance !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}.`);
  if (schema.enum && !schema.enum.includes(instance)) errors.push(`${path} is not an allowed value.`);
  if (schema.pattern && typeof instance === 'string' && !new RegExp(schema.pattern).test(instance)) errors.push(`${path} does not match ${schema.pattern}.`);
  if (schema.format === 'uri-reference' && typeof instance === 'string') {
    try {
      new URL(instance, 'https://schema.invalid/');
    } catch {
      errors.push(`${path} is not a URI reference.`);
    }
  }

  if (schema.type === 'object' || schema.properties || schema.required) {
    for (const required of schema.required || []) if (!(required in instance)) errors.push(`${path} is missing ${required}.`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(instance)) if (!(key in (schema.properties || {}))) errors.push(`${path}.${key} is not allowed.`);
    }
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (key in instance) errors.push(...validate(instance[key], propertySchema, `${path}.${key}`, base));
    }
  }

  if (schema.type === 'array') {
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
