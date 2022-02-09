const test = require('brittle')
const net = require('net')
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

test('createServer + connect - emits connect', async function (t) {
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

  socket.once('connect', function () {
    lc.pass('client side emitted connect')
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

test('createServer + connect - exchange data', async function (t) {
  const [a, b] = await swarm(t)
  const lc = t.test('socket lifecycle')

  lc.plan(5)

  const server = a.createServer(function (socket) {
    lc.pass('server side opened')

    socket.on('data', function (data) {
      socket.write(data)
    })

    socket.once('end', function () {
      lc.pass('server side ended')
      socket.end()
    })
  })

  await server.listen()

  const socket = b.connect(server.publicKey)
  const blk = Buffer.alloc(4096)
  const expected = 20 * 1024 * blk.byteLength

  let sent = 0
  let recv = 0

  for (let i = 0; i < 10; i++) send()

  function send () {
    sent += blk.byteLength
    socket.write(blk)
  }

  socket.on('data', function (data) {
    recv += data.byteLength
    if (recv === expected) {
      lc.is(sent, expected, 'client sent all data')
      lc.is(recv, expected, 'client received all data')
      socket.end()
    } else if (sent < expected) {
      send()
    }
  })

  socket.once('end', function () {
    lc.pass('client side ended')
  })

  await lc
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

  const socket = b.connect(server.publicKey, {
    fastOpen: false
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
    fastOpen: false,
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

test('tcp noise, client ends, no crash', async function (t) {
  const [, node] = await swarm(t, 2)
  const sock = net.connect(node.address().port)

  sock.end('hi')

  await new Promise((resolve) => sock.on('close', resolve))
  t.pass('did not crash')
})

test('half open', async function (t) {
  t.plan(2)

  const [, a] = await swarm(t)

  const server = a.createServer()
  await server.listen()

  const socket = a.connect(server.address().publicKey)

  server.on('connection', (socket) => {
    socket.on('data', (data) => {
      t.alike(data.toString(), 'ping')
      setTimeout(() => socket.end('pong'))
    })
  })

  socket
    .on('data', (data) => {
      t.alike(data.toString(), 'pong')
    })
    .end('ping')
})

test('server responds and immediately ends, multiple connects', async function (t) {
  const [a, b] = await swarm(t)

  const lc = t.test('socket lifecycle')
  lc.plan(1)

  const server = a.createServer((socket) => {
    socket.end('hi')
  })

  await server.listen()

  let n = 100

  for (let i = n; i > 0; i--) {
    const socket = b.connect(server.publicKey)

    socket.on('open', () => {
      if (--n === 0) lc.pass()
    })
  }

  await lc

  await server.close()
})

test('dht node can host server', async function (t) {
  const [, b, c] = await swarm(t, 3)

  const lc = t.test('socket lifecycle')

  t.plan(2)
  lc.plan(4)

  const server = b.createServer(function (socket) {
    lc.pass('server side opened')

    socket.once('end', function () {
      lc.pass('server side ended')
      socket.end()
    })
  })

  await server.listen()

  const socket = c.connect(server.publicKey)

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
