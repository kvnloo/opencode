// AI-prepared independent evidence for cleardevice's OpenCode #54372.
// Executes extracted source functions and a provider callback with a spy-only editor.
// No Schema/Effect imports, default-model implementation, provider requests or network.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const args = process.argv.slice(2);
const contract = args.includes('--contract');
const repoIndex = args.indexOf('--repo');
const repo = repoIndex < 0 ? path.resolve(__dirname, '../..') : path.resolve(args[repoIndex + 1]);
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'source-hashes.json'), 'utf8'));
const encode = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const details = [];
let passed = 0;
let failed = 0;

try {
  const requireFromRepo = createRequire(path.join(repo, 'package.json'));
  const ts = process.env.OPENCODE_REVIEW_TYPESCRIPT
    ? require(process.env.OPENCODE_REVIEW_TYPESCRIPT)
    : requireFromRepo('typescript');
  const cached = new Map();
  for (const item of manifest.owner_sources) {
    const bytes = fs.readFileSync(path.join(repo, item.path));
    const gitBlob = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(gitBlob, item.git_blob_sha, `owner source hash mismatch: ${item.path}`);
    cached.set(item.path, bytes.toString('utf8'));
  }
  const frozenBase = fs.readFileSync(path.join(__dirname, 'base-migration-functions.ts'), 'utf8');
  assert.equal(hash(frozenBase), manifest.base_extract.sha256, 'frozen base extraction hash mismatch');
  console.log('PASS frozen owner/base source hashes');
  const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const migration = parse('migrate.ts', cached.get('packages/core/src/v1/config/migrate.ts'));
  const baseline = parse('base-migration-functions.ts', frozenBase);
  const provider = parse('provider.ts', cached.get('packages/core/src/config/plugin/provider.ts'));
  const extractions = [];
  const extracted = (source, node) => {
    const text = node.getText(source);
    extractions.push({ source: source.fileName,
      first_line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      last_line: source.getLineAndCharacterOfPosition(node.end).line + 1,
      sha256: hash(text) });
    return text.replace(/^export /, '');
  };
  const functions = (source, names) => {
    const found = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
    assert.equal(found.length, names.length, `missing source functions: ${source.fileName}`);
    return found.map(n => extracted(source, n)).join('\n');
  };
  const evaluate = (code, context) => vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, { ...context }, { timeout: 1000 });
  const context = {
    ConfigProvider: { ModelWildcard: '*' },
    ConfigProviderOptionsV1: { provider: () => ({}) },
    Provider: { aisdk: name => name.startsWith('aisdk:') ? name : `aisdk:${name}` },
  };
  const migrationNames = ['migrateProvider', 'migrateStandardProvider', 'migrateModels',
    'migrateAzureCognitiveServicesProvider', 'migrateGoogleVertexAnthropicProvider'];
  const migrate = evaluate(functions(migration, migrationNames) + '\nmigrateProvider', context);
  const baselineNames = migrationNames.filter(n => n !== 'migrateModels');
  const oldMigrate = evaluate(functions(baseline, baselineNames) + '\nmigrateProvider', context);
  const isToggleOnly = evaluate(functions(provider, ['isToggleOnly']) + '\nisToggleOnly', {});
  const configuredProviders = evaluate(functions(provider, ['configuredProviders']) + '\nconfiguredProviders', {});
  const callbacks = [];
  function walk(n) {
    if (ts.isCallExpression(n) && n.expression.getText(provider) === 'ctx.provider.transform') {
      assert.equal(n.arguments.length, 1);
      callbacks.push(extracted(provider, n.arguments[0]));
    }
    ts.forEachChild(n, walk);
  }
  walk(provider);
  assert.equal(callbacks.length, 1);
  const modelSchema = cached.get('packages/schema/src/config/provider.ts');
  assert.match(modelSchema, /package: Schema.String.pipe\(optional\)/);
  assert.match(modelSchema, /disabled: Schema.Boolean.pipe\(optional\)/);

  function requests(id, migrated, existing = []) {
    const current = { provider: { id, integrationID: id },
      models: new Map(existing.map(key => [key, { id: key }])) };
    const calls = [];
    // Spy only: records update requests, does not create or emulate a model.
    const editor = {
      get: key => key === id ? current : undefined,
      update: (key, fn) => { assert.equal(key, id); fn(current.provider); },
      models: { update: (key, modelID) => { assert.equal(key, id); calls.push(modelID); } },
    };
    evaluate(`(${callbacks[0]})`, { ...context, structuredClone, isToggleOnly, configuredProviders,
      sources: { models: new Map() },
      loaded: { entries: [{ type: 'document', info: { providers: { [id]: migrated } } }] },
      Config: { latest: () => undefined },
    })(editor);
    return calls;
  }
  function test(name, fn) {
    try {
      const result = fn();
      details.push({ name, status: 'pass', ...result });
      passed++;
      console.log(`PASS ${name}`);
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      details.push({ name, status: 'fail', expected: error.expected, actual: error.actual });
      failed++;
      console.log(`FAIL ${name}: expected=${JSON.stringify(error.expected)} actual=${JSON.stringify(error.actual)}`);
    }
  }
  test('ordinary blacklist skips absent ID', () => {
    const info = migrate('ordinary', { blacklist: ['missing'] });
    const updates = requests('ordinary', info);
    assert.equal(isToggleOnly(info.models.missing), true);
    assert.deepEqual(updates, []);
    return { migrated: encode(info), requested_updates: updates };
  });
  test('ordinary whitelist skips absent ID and wildcard', () => {
    const info = migrate('ordinary', { whitelist: ['missing'] });
    const updates = requests('ordinary', info);
    assert.deepEqual(updates, []);
    return { migrated: encode(info), requested_updates: updates };
  });
  test('base blacklist migration synthesizes no model', () => {
    const info = oldMigrate('google-vertex-anthropic', { blacklist: ['missing'] });
    assert.equal(info.models, undefined);
    const updates = requests('google-vertex', info);
    assert.deepEqual(updates, []);
    return { migrated: encode(info), requested_updates: updates };
  });
  test('removing only synthetic package restores skip (mechanism control)', () => {
    const info = migrate('google-vertex-anthropic', { blacklist: ['missing'] });
    delete info.models.missing.package;
    const updates = requests('google-vertex', info);
    assert.deepEqual(updates, []);
    return { migrated: encode(info), requested_updates: updates };
  });
  test('blacklist matching existing Vertex ID requests no creation', () => {
    const info = migrate('google-vertex-anthropic', { blacklist: ['known'] });
    const updates = requests('google-vertex', info, ['known']);
    assert.deepEqual(updates, []);
    return { migrated: encode(info), requested_updates: updates };
  });
  test('explicit authored package/name requests intentional custom definition', () => {
    const info = { models: { custom: { name: 'Custom', package: 'aisdk:@ai-sdk/google-vertex/anthropic' } } };
    const updates = requests('google-vertex', info);
    assert.deepEqual(updates, ['custom']);
    return { config: info, requested_updates: updates };
  });
  for (const list of ['whitelist', 'blacklist']) {
    test(`${contract ? 'contract' : 'observation'}: absent Vertex ${list} ID`, () => {
      const input = { [list]: ['missing'] };
      const info = migrate('google-vertex-anthropic', input);
      const updates = requests('google-vertex', info);
      assert.equal(info.models.missing.disabled, list === 'blacklist');
      assert.equal(info.models.missing.package, 'aisdk:@ai-sdk/google-vertex/anthropic');
      assert.equal(updates.includes('*'), false);
      assert.deepEqual(updates, contract ? [] : ['missing']);
      return { input, migrated: encode(info), requested_updates: updates };
    });
  }
  const result = { owner: manifest.owner, pr: manifest.pr, owner_head: manifest.owner_head,
    base: manifest.base, mode: contract ? 'frozen intended contract' : 'frozen observed owner behavior',
    type: 'Extracted-function/callback checks with spy-only provider editor; not runtime acceptance',
    passed, failed, typescript_version: ts.version, extractions, checks: details,
    limits: ['No actual normalize/Schema decode/encode, Effect runtime, default-model implementation, catalog fold, model transform, activation/policy, resolver, plugin host or provider request.',
      'ConfigProviderOptionsV1.provider is stubbed for empty options only; Provider.aisdk maps package names; configured document/source data and provider editor are bounded fixtures.',
      'Package-removal is a synthetic-input mechanism control, not a production fix or green implementation.'],
  };
  const outputArg = args.indexOf('--output');
  if (outputArg >= 0) fs.writeFileSync(path.resolve(args[outputArg + 1]), JSON.stringify(result, null, 2) + '\n');
  console.log(`SUMMARY checks=${passed + failed} passed=${passed} failed=${failed} mode=${contract ? 'contract' : 'observation'}`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  // Logs are portable: do not emit workstation paths or credentials.
  console.error(`BLOCKED ${error.code || error.name}: source/dependency contract not satisfied; see README.md`);
  process.exitCode = 2;
}
