import assert from 'node:assert'
import fs     from 'node:fs/promises'
import Core   from '@superhero/core'
import { before, after, suite, test } from 'node:test'

suite('@superhero/core', () =>
{
  const
    testDir       = './test',
    fooDir        = `${testDir}/foo`,
    fooService    = `${fooDir}/service.js`,
    fooConfig     = `${fooDir}/config.json`,
    fooConfigDev  = `${fooDir}/config-dev.json`

  before(async () =>
  {
    // Create test directories
    await fs.mkdir(fooDir, { recursive: true })

    // Create mock service files
    await fs.writeFile(fooService, 'export default class Foo { static locate() { return new Foo() } bootstrap(config) { this.bar = config.bar } }')

    // Create mock config files
    await fs.writeFile(fooConfig,     JSON.stringify({ foo: { bar: 'baz' }, bootstrap: { foo: true }, locator: { 'foo': fooService } }))
    await fs.writeFile(fooConfigDev,  JSON.stringify({ foo: { bar: 'qux' } }))

    // Disable console output for the tests
    // Object.defineProperties(console, 
    // {
    //   info: { value: () => null },
    //   warn: { value: () => null }
    // })
  })

  after(async () => 
  {
    await fs.rm(testDir, { recursive: true, force: true })
  })

  let core

  test('Plain core bootstrap', async () =>
  {
    core = new Core()

    await assert.doesNotReject(
      core.bootstrap(),
      'Should bootstrap without errors')
  })

  test('Bootstraps a service successfully', async () =>
  {
    core = new Core()
    await core.add(fooConfig)

    await assert.doesNotReject(
      core.bootstrap(),
      'Should bootstrap without errors')

    const foo = core.locate('foo')

    assert.ok(foo, 'Should have located the foo service')
    assert.strictEqual(foo.bar, 'baz', 'Should have passed the correct configuration to the service')
  })

  test('Bootstraps a service with a branch variable', async () =>
  {
    const branch = 'dev'
    core = new Core(branch)
    await core.add(fooConfig)

    await assert.doesNotReject(
      core.bootstrap(),
      'Should bootstrap without errors')

    const foo = core.locate('foo')

    assert.ok(foo, 'Should have located the foo service')
    assert.strictEqual(foo.bar, 'qux', 'Should have passed the correct configuration to the service')
  })

  test('Can cluster the core and bootstrap a service', async () =>
  {
    core = new Core()
    await core.cluster(4)
    await core.add(fooConfig)

    await assert.doesNotReject(
      core.bootstrap(),
      'Should bootstrap without errors')

    await core.destruct()
  })
})
