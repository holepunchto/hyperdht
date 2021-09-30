const test = require('brittle')
const { swarm } = require('./helpers')
const DHT = require('../')

test('createServer + connect - once defaults', async function (t) {
  const [a, b] = await swarm(t)
  const lc = t.test('socket lifecycle')

  t.plan(2)
  lc.plan(4)

  const server = a.createServer(function (socket) {
    lc.pass('server side opened')

    socket.once('end', function () {
      lc.pass('server side ended')
      socket.end()
    })
  })

  await server.listen()

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

test('createServer + connect - force holepunch', async function (t) {
  const [boot] = await swarm(t)

  const bootstrap = [{ host: '127.0.0.1', port: boot.address().port }]
  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  await a.ready()
  await b.ready()

  const lc = t.test('socket lifecycle')
  lc.plan(6)

  const server = a.createServer({ shareLocalAddress: false }, function (socket) {
    lc.ok(!!socket.rawStream._utp, 'server is utp') // TODO: make this easier to detect!
    lc.pass('utp server side opened')

    socket.once('end', function () {
      lc.pass('utp server side ended')
      socket.end()
    })
  })

  await server.listen()

  const socket = b.connect(server.publicKey)

  socket.once('open', function () {
    lc.ok(!!socket.rawStream._utp, 'client is utp') // TODO: make this easier to detect!
    lc.pass('utp client side opened')
  })

  socket.once('end', function () {
    lc.pass('utp client side ended')
  })

  socket.end()

  await lc

  await server.close()
  await a.destroy()
  await b.destroy()
})

test('server choosing to abort holepunch', async function (t) {
  const [boot] = await swarm(t)

  const bootstrap = [{ host: '127.0.0.1', port: boot.address().port }]
  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  await a.ready()
  await b.ready()

  const lc = t.test('socket lifecycle')
  lc.plan(2)

  const server = a.createServer({
    shareLocalAddress: false,
    holepunch () {
      lc.pass('server should trigger holepuncher hook')
      return false
    }
  }, function (socket) {
    lc.fail('server should not make a connection')
  })

  await server.listen()

  const socket = b.connect(server.publicKey)

  socket.once('open', function () {
    lc.fail('client should not make a connection')
  })

  socket.once('error', function (err) {
    lc.ok(!!err, 'client socket should error')
  })

  await lc

  await server.close()
  await a.destroy()
  await b.destroy()
})

test('client choosing to abort holepunch', async function (t) {
  const [boot] = await swarm(t)

  const bootstrap = [{ host: '127.0.0.1', port: boot.address().port }]
  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  await a.ready()
  await b.ready()

  const lc = t.test('socket lifecycle')
  lc.plan(2)

  const server = a.createServer({ shareLocalAddress: false }, function (socket) {
    lc.fail('server should not make a connection')
  })

  await server.listen()

  const socket = b.connect(server.publicKey, {
    holepunch () {
      lc.pass('client is aborting')
      return false
    }
  })

  socket.once('open', function () {
    lc.fail('client should not make a connection')
  })

  socket.once('error', function (err) {
    lc.ok(!!err, 'client socket should error')
  })

  await lc

  await server.close()
  await a.destroy()
  await b.destroy()
})
