const test = require('brittle')
const { toArray } = require('./helpers')
const DHT = require('../')

test('single node network is enough to find peers', async function (t) {
  // const bootstrap1 = DHT.bootstrapper(49737, '127.0.0.1', { host: '0.0.0.0' }) // + otherwise host binds to :: (IPv6), but it requires '127.0.0.1' (IPv4) as a bootstrap host
  const bootstrap1 = DHT.bootstrapper(49737, '127.0.0.1')
  await bootstrap1.ready()

  // const bootstrap = [bootstrap1.address()] // + a bootstrap like { host: '::', port: 49737 } doesn't work, but this one does: { host: '0.0.0.0', port: 49737 }
  const bootstrap = [{ host: '127.0.0.1', port: bootstrap1.address().port }]

  const a = new DHT({ bootstrap, ephemeral: true })
  const server = a.createServer()
  await server.listen()

  const b = new DHT({ bootstrap, ephemeral: true })
  const result = await toArray(b.findPeer(server.publicKey))

  t.ok(result.length > 0, 'has at least one result')
  t.alike(result[0].peer.publicKey, server.publicKey)

  await b.destroy()
  await a.destroy()
  await bootstrap1.destroy()
})
