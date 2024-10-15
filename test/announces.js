const test = require('brittle')
const { swarm, toArray } = require('./helpers')
const DHT = require('../')
const HyperDHT = require('../')

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

test('server listen returns server', async function (t) {
  const [a, b] = await swarm(t)

  const server = await a.createServer().listen()
  const result = await toArray(b.findPeer(server.publicKey))

  t.ok(result.length > 0, 'has at least one result')
  t.alike(result[0].peer.publicKey, server.publicKey)
})

test('server suspends and resumes', async function (t) {
  const [a, b] = await swarm(t)
  const server = await a.createServer().listen()

  t.ok((await toArray(b.findPeer(server.publicKey))).length > 0)

  await server.suspend()

  t.ok((await toArray(b.findPeer(server.publicKey))).length === 0)

  server.resume()

  // be nice to have an api for the next announce cycle here...
  await new Promise((resolve) => setTimeout(resolve, 1000))

  t.ok((await toArray(b.findPeer(server.publicKey))).length > 0)
})

test('server announces relay addrs', async function (t) {
  const [, a, b] = await swarm(t)

  // ensure dht is fully connected...
  await a.findNode(a.id).finished()
  await b.findNode(b.id).finished()

  const server = await a.createServer().listen()
  const q = b.findPeer(server.publicKey)
  const nodes = await toArray(q)

  for (const addr of server.relayAddresses) {
    let found = false

    for (const node of nodes) {
      found = node.from.port === addr.port && node.from.host === addr.host
      if (found) break
    }

    if (!found) {
      const { host, port } = b.remoteAddress()
      found = port === addr.port && host === addr.host
    }

    if (!found) {
      const { host, port } = a.remoteAddress()
      found = port === addr.port && host === addr.host
    }

    t.ok(found, 'found addr')
  }
})

test('connect when we relay ourself', async function (t) {
  const testnet = await swarm(t)

  const server = await testnet.nodes[1].createServer(function (sock) {
    sock.resume()
    sock.end()
  }).listen()

  const addr = server.relayAddresses[server.relayAddresses.length - 1]

  for (const node of testnet.nodes) {
    const { host, port } = node.remoteAddress()
    if (addr.port === port && addr.host === host) {
      const sock = node.connect(server.publicKey)
      await sock.opened
      t.pass('worked')
      sock.end()
      await new Promise(resolve => sock.once('close', resolve))
      break
    }
  }
})

test('announcer background does not over-trigger', async function (t) {
  // Note: Not a great test, since it accesses private prop of dht-rpc/io
  // Feel free to remove this test if _tid behaviour changes, since it's
  // mostly used to document a previous bug

  const testnet = await swarm(t, 2) // must be <=3 (less than announcer MIN_ACTIVE) to trigger previous bug
  const bootstrap = testnet.bootstrap

  const a = new HyperDHT({ bootstrap })

  const initTid = a.io._tid
  const server = a.createServer()
  await server.listen()

  // give some time for possible background spam
  await new Promise(resolve => setTimeout(resolve, 500))

  const requestsSent = initTid > a.io._tid // it wrapped?
    ? a.io._tid // close enough for this test (ignoring those before wrapping)
    : a.io._tid - initTid

  t.ok(
    requestsSent < 50,
    `No background spam of ping requests (saw ${requestsSent})`
  )

  await a.destroy()
})
