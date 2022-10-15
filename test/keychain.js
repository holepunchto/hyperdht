const test = require('brittle')
const { swarm } = require('./helpers')
const Keychain = require('keypear')

test('createServer with keypear + connect', async function (t) {
  t.plan(2)

  const keys = new Keychain()

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

  await server.listen(keys.get())

  const socket = b.connect(server.publicKey)

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
