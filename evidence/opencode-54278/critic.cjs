// Independent bounded source-function witness. No gray-matter or application import.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { stripTypeScriptTypes } = require('node:module')

const subject = process.argv[2] || 'head'
const engineName = process.argv[3] || 'js-yaml'
assert.ok(['base', 'head'].includes(subject))
assert.ok(['js-yaml', 'yaml'].includes(engineName))
assert.ok(process.argv[4], 'Supply an existing YAML package directory as argument 3; this runner never installs dependencies')
const dependency = path.resolve(process.argv[4])
const packageInfo = require(path.join(dependency, 'package.json'))
assert.equal(packageInfo.name, engineName)
assert.equal(packageInfo.version, engineName === 'js-yaml' ? '4.3.2' : '2.9.1',
  'Only the corroborating engine versions actually reviewed are supported')
const engine = require(dependency)
const parseYaml = engineName === 'js-yaml' ? engine.load : engine.parse
const source = fs.readFileSync(path.join(__dirname, 'frozen', `${subject}-markdown.ts`), 'utf8')
const blob = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex')
assert.equal(blob, subject === 'head'
  ? 'c39f4305b77783e426f069981ddf4cb899a44739' : '8093ff7e735429fc9eb8750578d9e136db63c46f')

const inputs = {
  'multiline-request': {
    yaml: 'request: {\n  headers: {x-critic: context}\n}',
    expected: { request: { headers: { 'x-critic': 'context' } } },
  },
  'multiline-permissions': {
    yaml: 'permissions: [\n  {action: read, resource: "*", effect: deny}\n]',
    expected: { permissions: [{ action: 'read', resource: '*', effect: 'deny' }] },
  },
  'alias-permissions': {
    yaml: 'request:\n  body:\n    rule: &rule {action: read, resource: "*", effect: deny}\npermissions: [*rule]',
    expected: {
      request: { body: { rule: { action: 'read', resource: '*', effect: 'deny' } } },
      permissions: [{ action: 'read', resource: '*', effect: 'deny' }],
    },
  },
}

// This deliberately lacks gray-matter cache/delimiter/language behavior.
// Fixtures use only plain --- frontmatter and one YAML document.
function matterAdapter(document, options) {
  assert.equal(JSON.stringify(options), '{}')
  assert.ok(document.startsWith('---\n'))
  const end = document.indexOf('\n---', 4)
  assert.ok(end >= 0)
  return { data: parseYaml(document.slice(4, end)), content: document.slice(end + 4) }
}
const transformed = stripTypeScriptTypes(source
  .replace(/^export \* as ConfigMarkdown[^\n]*\n/m, '')
  .replace(/^import matter[^\n]*\n/m, '')
  .replace(/export function /g, 'function '))
const config = vm.runInNewContext(transformed + '\n;({parse, parseOption, sanitize})',
  { matter: matterAdapter }, { timeout: 1000 })

console.log(JSON.stringify({ subject, blob, node: process.version,
  adapterEngine: engineName, adapterVersion: packageInfo.version,
  limitation: 'Not gray-matter 4.0.3/js-yaml 3.x or native agent/schema acceptance' }))
let failed = 0
for (const [name, fixture] of Object.entries(inputs)) {
  for (const recovery of [false, true]) {
    const label = `${name}/${recovery ? 'colon-recovery' : 'quoted-control'}`
    const document = `---\ndescription: ${recovery ? 'Scope: test' : '"Scope: test"'}\n${fixture.yaml}\nmode: subagent\n---\nBody`
    try {
      // All assertions encode intended contract, rather than expected breakage.
      const parsed = config.parse(document)
      assert.deepEqual(parsed.data, {
        description: 'Scope: test', ...fixture.expected, mode: 'subagent',
      })
      assert.equal(parsed.content.trim(), 'Body')
      console.log(`PASS ${label}`)
    } catch (error) {
      failed++
      console.log(`FAIL ${label}: ${error.name}: ${error.message}`)
      console.log(`SANITIZED ${JSON.stringify(config.sanitize(document))}`)
      console.log(`PARSE_OPTION ${JSON.stringify(config.parseOption(document))}`)
    }
  }
}
console.log(`${6 - failed}/6 intended-contract assertions passed; ${failed} failed`)
process.exitCode = failed ? 1 : 0
