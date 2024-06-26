const createTestnet = require('../../testnet')
const NewlineDecoder = require('newline-decoder')
const { spawn } = require('child_process')
const goodbye = require('graceful-goodbye')

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
  const kill = () => setTimeout(() => proc.kill('SIGKILL'), 1000)
  const unregisterExitHandlers = goodbye(() => proc.kill('SIGKILL'))

  proc.stderr.on('data', err => t.fail(err))

  for await (const data of proc.stdout) {
    for (const line of nl.push(data)) yield [kill, line]
  }

  unregisterExitHandlers()
}
