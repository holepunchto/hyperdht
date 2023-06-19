const createTestnet = require('../../testnet')
const UDX = require('udx-native')

module.exports = { swarm, toArray, freePort }

async function toArray (iterable) {
  const result = []
  for await (const data of iterable) result.push(data)
  return result
}

async function swarm (t, n = 32, bootstrap = []) {
  return createTestnet(n, { bootstrap, teardown: t.teardown })
}

async function freePort () {
  const socket = new UDX().createSocket()
  socket.bind(0)
  const port = socket.address().port
  await socket.close()
  return port
}
