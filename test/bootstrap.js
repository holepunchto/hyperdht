const test = require('brittle')
const DHT = require('../')

test('local bootstrap with non ephemeral server', async function (t) {
  const bootstrap1 = DHT.bootstrapper(49737, '127.0.0.1')
  await bootstrap1.ready()

  const bootstrap = [{ host: '127.0.0.1', port: bootstrap1.address().port }]
  await createServerAndConnect(t, { bootstrap, ephemeral: false })

  await bootstrap1.destroy()
})

test('local bootstrap with ephemeral server', async function (t) {
  const bootstrap1 = DHT.bootstrapper(49737, '127.0.0.1')
  await bootstrap1.ready()

  const bootstrap = [{ host: '127.0.0.1', port: bootstrap1.address().port }]
  await createServerAndConnect(t, { bootstrap, ephemeral: true })

  await bootstrap1.destroy()
})

test('online bootstrap with non ephemeral server', async function (t) {
  const bootstrap = [{ host: 'dht1.lukks.ar', port: 49737 }]
  await createServerAndConnect(t, { bootstrap, ephemeral: false })
})

test('online bootstrap with ephemeral server', async function (t) {
  const bootstrap = [{ host: 'dht1.lukks.ar', port: 49737 }]
  await createServerAndConnect(t, { bootstrap, ephemeral: true })
})

async function createServerAndConnect (t, { bootstrap, ephemeral }) {
  const a = new DHT({ bootstrap, ephemeral })
  const b = new DHT({ bootstrap })

  await a.ready()
  await b.ready()

  const lc = t.test('socket lifecycle')
  lc.plan(2)

  const server = a.createServer(function (socket) {
    socket.once('error', () => {})
    socket.once('end', () => socket.end())
  })
  await server.listen()

  const socket = b.connect(server.publicKey)

  socket.on('error', function (error) {
    lc.fail(error.message) // Could not find peer
    lc.pass()
  })

  socket.once('open', function () {
    lc.pass('client side opened')
  })

  socket.once('end', function () {
    lc.pass('client side ended')
  })

  socket.end()

  await lc

  await server.close()
  await b.destroy()
  await a.destroy()
}
