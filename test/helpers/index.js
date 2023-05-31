const createTestnet = require('../../testnet')

module.exports = { swarm, toArray }

async function toArray (iterable) {
  const result = []
  for await (const data of iterable) result.push(data)
  return result
}

async function swarm (t, n = 32, bootstrap = []) {
  return createTestnet(n, { bootstrap, teardown: t.teardown })
}
