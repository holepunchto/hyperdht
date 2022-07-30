const test = require('brittle')
// const { swarm } = require('./helpers')
const DHT = require('../')
// const { BOOTSTRAP_NODES } = require('../lib/constants.js')

test('bootstrapper', async function (t) {
  const node = DHT.bootstrapper(49737)

  await node.ready()
  t.is(typeof node.address().host, 'string')
  t.is(typeof node.address().family, 'number')
  t.is(typeof node.address().port, 'number')

  await node.destroy()
})

test('local bootstrap with default node settings', async function (t) {
  const bootstrap1 = new DHT({ bootstrap: [], port: 49737, anyPort: false, ephemeral: false, firewalled: false })
  await bootstrap1.ready()

  const bootstrap = [bootstrap1.address()]
  // const bootstrap = BOOTSTRAP_NODES // if you use default mainnet bootstraps, the test would work
  // const bootstrap = [{ host: 'dht1.lukks.ar', port: 49737 }] // or this one (created with: hyperswarm-dht --bootstrap)

  // for the test to pass using an own local bootstrap, this "a" node should have {ephemeral:false}
  // but that is not required when using online bootstraps
  const a = new DHT({ bootstrap })
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
  await bootstrap1.destroy()
})

test('online bootstrap with default node settings', async function (t) {
  const bootstrap = [{ host: 'dht1.lukks.ar', port: 49737 }]
  const a = new DHT({ bootstrap })
  const b = new DHT({ bootstrap })

  await a.ready()
  await b.ready()

  const lc = t.test('socket lifecycle')
  lc.plan(2)

  const server = a.createServer(function (socket) {
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
})
