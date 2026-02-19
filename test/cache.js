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

  const q = b.findPeer(server.publicKey)
  const result = await toArray(q)
  const target = HyperDHT.EncodeKey(server.publicKey, [result[0].to])

  console.log(target)

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
