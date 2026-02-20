const test = require('brittle')
const { swarm, toArray } = require('./helpers')
const DHT = require('../')
const HyperDHT = require('../')

test('createServer + connect - once defaults', async function (t) {
  t.plan(2)

  const [a, b] = await swarm(t)
  const lc = t.test('socket lifecycle')

  lc.plan(4)

  const server = a.createServer(function (socket) {
    lc.pass('server side opened')

    socket.once('end', function () {
      lc.pass('server side ended')
      socket.end()
    })
  })

  await server.listen()

  const target = HyperDHT.EncodeKey(server.publicKey, [
    { host: b.io._boundServerPort, port: b.io._boundServerPort }
  ])

  const socket = b.connect(target)

  socket.once('open', function () {
    lc.pass('client side opened')
  })

  socket.once('end', function () {
    lc.pass('client side ended')
  })

  socket.end()

  await lc

  server.on('close', function () {
    t.pass('server closed')
  })

  await server.close()
})
