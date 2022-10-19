const test = require('brittle')
const { swarm } = require('./helpers')
const Keychain = require('keypear')

test('server with keychain', async function (t) {
  t.plan(4)

  const [a, b] = await swarm(t)
  const keys = new Keychain()
  const serverKeyPair = keys.get()

  const server = a.createServer()
  await server.listen(serverKeyPair)
  t.is(server.publicKey, serverKeyPair.publicKey)

  const socket = b.connect(server.publicKey)

  server.on('connection', (socket) => {
    t.is(socket.publicKey, serverKeyPair.publicKey)
    t.pass('server connected')
    socket.end()
  })

  socket.on('open', () => {
    t.pass('client connected')
    socket.end()
  })
})

test('client with keychain', async function (t) {
  t.plan(4)

  const [a, b] = await swarm(t)
  const keys = new Keychain()
  const clientKeyPair = keys.get()

  const server = a.createServer()
  await server.listen()

  const socket = b.connect(server.publicKey, { keyPair: clientKeyPair })
  t.is(socket.publicKey, clientKeyPair.publicKey)

  server.on('connection', (socket) => {
    t.alike(socket.remotePublicKey, clientKeyPair.publicKey)
    t.pass('server connected')
    socket.end()
  })

  socket.on('open', () => {
    t.pass('client connected')
    socket.end()
  })
})

test('server and client, both with keychain', async function (t) {
  t.plan(2)

  const [a, b] = await swarm(t)
  const keys = new Keychain()

  const server = a.createServer()
  await server.listen(keys.get('server'))

  const socket = b.connect(server.publicKey, { keyPair: keys.get('client') })

  server.on('connection', (socket) => {
    t.pass('server connected')
    socket.end()
  })

  socket.on('open', () => {
    t.pass('client connected')
    socket.end()
  })
})
