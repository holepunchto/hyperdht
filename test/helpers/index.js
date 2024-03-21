const createTestnet = require('../../testnet')
const NewlineDecoder = require('newline-decoder')
const { spawn } = require('child_process')

module.exports = { swarm, toArray, spawnFixture }

async function toArray (iterable) {
  const result = []
  for await (const data of iterable) result.push(data)
  return result
}

async function swarm (t, n = 32, bootstrap = []) {
  return createTestnet(n, { bootstrap, teardown: t.teardown })
}

async function * spawnFixture (t, args) {
  const proc = spawn(process.execPath, args)
  const nl = new NewlineDecoder()

  proc.stderr.on('data', err => t.fail(err))
  const kill = () => setTimeout(() => proc.kill('SIGKILL'), 1000)

  for await (const data of proc.stdout) {
    for (const line of nl.push(data)) yield [kill, line]
  }
}
