const test = require('brittle')
const { swarm } = require('./helpers')
const HyperDHTAddress = require('hyperdht-address')

test('cache - key with nodes', async function (t) {
  t.plan(3)

  const [a, b] = await swarm(t)
  const ts = t.test('server')

  ts.plan(2)

  const server = a.createServer(function (socket) {
    ts.pass('server side opened')

    socket.once('end', function () {
      ts.pass('server side ended')
      socket.end()
    })
  })

  await server.listen()

  {
    const tn = t.test('client w/nodes')
    tn.plan(2)

    const target = HyperDHTAddress.encode(server.publicKey, [
      { host: b.io._boundServerPort, port: b.io._boundServerPort }
    ])

    const socket = b.connect(target)

    socket.once('open', function () {
      tn.pass('client side opened')
    })

    socket.once('end', function () {
      tn.pass('client side ended')
    })

    socket.end()

    await tn
  }

  server.on('close', function () {
    t.pass('server closed')
  })

  await server.close()
})
