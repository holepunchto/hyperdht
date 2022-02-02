const test = require('brittle')
const { swarm, toArray } = require('./helpers')
const DHT = require('../')

test('server listen and findPeer', async function (t) {
  const [a, b] = await swarm(t)

  const server = a.createServer()
  await server.listen()

  const result = await toArray(b.findPeer(server.publicKey))

  t.ok(result.length > 0, 'has at least one result')
  t.alike(result[0].peer.publicKey, server.publicKey)
})

test('server listen and lookup', async function (t) {
  const [a, b] = await swarm(t)

  const server = a.createServer()
  await server.listen()

  const result = await toArray(b.lookup(server.target))

  t.ok(result.length > 0, 'has at least one result')
  t.alike(result[0].peers.length, 1)
  t.alike(result[0].peers[0].publicKey, server.publicKey)
})

test('announce to group and lookup', async function (t) {
  const [a, b] = await swarm(t)
  const keyPair1 = DHT.keyPair()
  const keyPair2 = DHT.keyPair()
  const target = DHT.hash(Buffer.from('testing...'))

  await a.announce(target, keyPair1, []).finished()

  {
    const result = await toArray(b.lookup(target))
    t.ok(result.length > 0, 'has at least one result')
    t.alike(result[0].peers.length, 1, 'one peer')
    t.alike(result[0].peers[0].publicKey, keyPair1.publicKey)
  }

  await a.announce(target, keyPair2, [{ host: '1.2.3.4', port: 1234 }]).finished()

  {
    const result = await toArray(b.lookup(target))
    t.ok(result.length > 0, 'has at least one result')
    t.alike(result[0].peers.length, 2, 'two peers')
    t.alike([result[0].peers[0].publicKey, result[0].peers[1].publicKey].sort(), [keyPair1.publicKey, keyPair2.publicKey].sort())

    const latest = result[0].peers[result[0].peers[0].publicKey.equals(keyPair2.publicKey) ? 0 : 1]

    t.is(latest.relayAddresses.length, 1, 'announced one relay')
    t.alike(latest.relayAddresses[0], { host: '1.2.3.4', port: 1234 })
  }

  for await (const data of a.findPeer(keyPair1.publicKey)) {
    t.fail('peer should not be announced')
    t.absent(data, 'just make standard happy')
  }

  for await (const data of a.findPeer(keyPair2.publicKey)) {
    t.fail('peer should not be announced')
    t.absent(data, 'just make standard happy')
  }
})

test('announce null relay addresses', async function (t) {
  const [a] = await swarm(t)
  const keyPair = DHT.keyPair()
  const target = DHT.hash(Buffer.from('testing...'))

  await t.execution(a.announce(target, keyPair, null).finished())
})
