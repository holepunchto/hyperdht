const { test, swarm, defer, destroy } = require('./helpers')
const HyperDHT = require('../')

test('listen and connect', async function (bootstrap, t) {
  const nodes = await swarm(bootstrap, 10)
  const keyPair = HyperDHT.keyPair()

  const server = nodes[0].createServer(function (connection) {
    t.pass('server got connection')

    connection.on('data', function (data) {
      t.pass('server received data')
      connection.write(Buffer.concat([Buffer.from('echo: '), data]))
    })

    connection.on('end', function () {
      connection.end()
    })
  })

  await server.listen(keyPair)

  t.pass('listening')

  const connection = nodes[nodes.length - 1].connect(keyPair.publicKey)

  connection.write(Buffer.from('hello'))

  await new Promise((resolve) => connection.once('open', resolve))
  t.pass('connected')

  const data = await new Promise((resolve) => connection.once('data', resolve))

  t.same(data, Buffer.from('echo: hello'), 'echoed data')

  connection.end()
  await server.close()

  destroy(nodes)
})

test('listen and connect multiple times', async function (bootstrap, t) {
  const nodes = await swarm(bootstrap, 10)
  const keyPair = HyperDHT.keyPair()

  const server = nodes[0].createServer(function (connection) {
    t.pass('server got connection')

    connection.on('data', function (data) {
      t.pass('server received data')
      connection.write(Buffer.concat([Buffer.from('echo: '), data]))
    })

    connection.on('end', function () {
      connection.end()
    })
  })

  await server.listen(keyPair)

  t.pass('listening')

  for (let i = 0; i < 5; i++) {
    const connection = nodes[nodes.length - 1].connect(keyPair.publicKey)

    connection.write(Buffer.from('hello'))

    const data = await new Promise((resolve) => connection.once('data', resolve))
    t.same(data, Buffer.from('echo: hello'), 'echoed data')

    connection.end()
  }

  await server.close()

  destroy(nodes)
})

test('announce and unannounce', async function (bootstrap, t) {
  const nodes = await swarm(bootstrap, 10)
  const keyPair = HyperDHT.keyPair()
  const target = Buffer.alloc(32)

  await nodes[0].announce(target, keyPair).finished()

  let found = 0
  for await (const node of nodes[0].lookup(Buffer.alloc(32))) {
    if (node) found++ // just to satify standard
  }

  t.ok(found > 0, 'found some ones')

  await nodes[0].unannounce(target, keyPair)

  found = 0
  for await (const node of nodes[0].lookup(Buffer.alloc(32))) {
    if (node) found++
  }

  t.ok(found === 0, 'found no nodes')

  destroy(nodes)
})

test('clearing announce', async function (bootstrap, t) {
  const nodes = await swarm(bootstrap, 10)
  const keyPair = HyperDHT.keyPair()
  const target = Buffer.alloc(32)

  const a = { host: nodes[0].remoteAddress().host, port: nodes[0].remoteAddress().port }
  const b = { host: nodes[5].remoteAddress().host, port: nodes[5].remoteAddress().port }

  await nodes[0].announce(target, keyPair, [a]).finished()

  for await (const node of nodes[0].lookup(Buffer.alloc(32))) {
    t.same(node.peers[0], { publicKey: keyPair.publicKey, nodes: [a] })
  }

  await nodes[1].announce(target, keyPair, [b], { clear: true }).finished()

  for await (const node of nodes[0].lookup(Buffer.alloc(32))) {
    t.same(node.peers[0], { publicKey: keyPair.publicKey, nodes: [b] })
  }

  destroy(nodes)
})

test('sets public key / remote public key', async function (bootstrap, t) {
  const nodes = await swarm(bootstrap, 10)
  const serverAssert = defer()
  const clientAssert = defer()

  const serverKeyPair = HyperDHT.keyPair()
  const clientKeyPair = HyperDHT.keyPair()

  const server = nodes[0].createServer(function (connection) {
    t.same(connection.publicKey, serverKeyPair.publicKey, 'server public key is server public key')
    t.same(connection.remotePublicKey, clientKeyPair.publicKey, 'server remote public key is client public key')

    connection.end()
    serverAssert.resolve()
  })

  await server.listen(serverKeyPair)

  const connection = nodes[1].connect(serverKeyPair.publicKey, clientKeyPair)

  connection.on('open', function () {
    t.same(connection.publicKey, clientKeyPair.publicKey, 'client public key is client public key')
    t.same(connection.remotePublicKey, serverKeyPair.publicKey, 'client remote public key is server public key')

    clientAssert.resolve()
  })

  connection.on('end', () => connection.end())

  await serverAssert
  await clientAssert

  server.close()
  destroy(nodes)
})

test('user defined firewall', async function (bootstrap, t) {
  t.plan(7)

  const nodes = await swarm(bootstrap, 10)
  const serverKeyPair = HyperDHT.keyPair()

  let firewalled = false
  let connected = false
  let remotePayload
  let remotePublicKey

  const server = nodes[0].createServer({ firewall }, function (connection) {
    connected = true
    connection.end()
  })

  await server.listen(serverKeyPair)

  const connection = nodes[1].connect(serverKeyPair.publicKey)

  await new Promise((resolve) => {
    connection.on('open', function () {
      t.ok(firewalled)
      t.same(remotePublicKey, nodes[1].defaultKeyPair.publicKey)
      t.ok(remotePayload.address)
      t.ok(remotePayload.localAddresses)
      t.ok(remotePayload.firewall)
    })

    connection.resume()

    connection.on('end', function () {
      t.ok(connected)
      connection.end()
      resolve()
    })
  })

  server.on('close', function () {
    t.pass('server closed')
  })

  await server.close()
  destroy(nodes)

  function firewall (publicKey, payload) {
    firewalled = true
    remotePublicKey = publicKey
    remotePayload = payload

    return true
  }
})
