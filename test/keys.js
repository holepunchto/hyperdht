const test = require('brittle')
const DHT = require('../')
const { swarm } = require('./helpers')
const Keychain = require('keypear')

test('incorrect short key', t => {
  t.plan(1)

  const node = new DHT()
  const buf = Buffer.from('not-a-correct-key')
  try {
    node.connect(buf)
  } catch (err) {
    t.is(err.message, 'ID must be 32-bytes long')
    node.destroy()
  }
})

test('correct publickey as a string is allowed', async t => {
  t.plan(2)

  const [a, b] = await swarm(t)
  const keys = new Keychain()
  const serverKeyPair = keys.get()

  const server = a.createServer()
  await server.listen(serverKeyPair)

  const publicKeyStr = serverKeyPair.publicKey.toString('hex')
  const socket = b.connect(publicKeyStr)

  server.on('connection', (socket) => {
    t.pass('server connected')
    socket.end()
  })

  socket.on('open', () => {
    t.pass('client connected')
    socket.end()
  })
})
