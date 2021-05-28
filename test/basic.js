const { test, swarm, destroy } = require('./helpers')
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
