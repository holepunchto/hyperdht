const createTestnet = require('../../testnet')
const NewlineDecoder = require('newline-decoder')
const { spawn } = require('child_process')
const goodbye = require('graceful-goodbye')
const DHT = require('../../')

module.exports = { swarm, toArray, spawnFixture, createDHT, endAndCloseSocket }

async function toArray(iterable) {
  const result = []
  for await (const data of iterable) result.push(data)
  return result
}

async function swarm(t, n = 32, bootstrap = []) {
  return createTestnet(n, { bootstrap, teardown: t.teardown })
}

async function* spawnFixture(t, args) {
  const proc = spawn(process.execPath, args)
  const nl = new NewlineDecoder()
  const kill = () => setTimeout(() => proc.kill('SIGKILL'), 1000)
  const unregisterExitHandlers = goodbye(() => proc.kill('SIGKILL'))

  proc.stderr.on('data', (err) => t.fail(err))

  for await (const data of proc.stdout) {
    for (const line of nl.push(data)) yield [kill, line]
  }

  unregisterExitHandlers()
}

function createDHT(opts) {
  return new DHT({ ...opts, host: '127.0.0.1' })
}

async function endAndCloseSocket(socket) {
  // We wait on the other side to end the stream too
  // So make sure a handler was added like
  //  socket.on('end', () => socket.end())
  socket.end()
  if (socket.destroyed) return
  await new Promise((resolve) => socket.on('close', resolve))
}
