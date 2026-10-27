const test = require('brittle')
const { swarm } = require('./helpers')

test('stats', async function (t) {
  const testnet = await swarm(t, 2)
  const dht = testnet.createNode()

  t.alike(dht.stats.punches, {
    consistent: 0,
    random: 0,
    open: 0,
    tryLater: 0,
    tryLaterRelayedHandshakesAtLeastOnce: 0
  })
  t.alike(dht.stats.relaying, { attempts: 0, successes: 0, aborts: 0 })
  t.alike(dht.stats.socketPool, { socketsAdded: 0, socketsRemoved: 0 })
})
