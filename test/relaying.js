const test = require('brittle')
const RelayServer = require('blind-relay').Server
const RAM = require('random-access-memory')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { swarm } = require('./helpers')
const DHT = require('../')

test('relay connections through node, client side', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const aServer = a.createServer({ shareLocalAddress: false }, function (socket) {
    lc.pass('server socket opened')
    socket
      .on('data', (data) => {
        lc.alike(data, Buffer.from('hello world'))
      })
      .on('close', () => {
        lc.pass('server socket closed')
      })
      .end()
  })

  await aServer.listen()

  const relay = new RelayServer({
    createStream (opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  const bServer = b.createServer({ shareLocalAddress: false }, function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await bServer.listen()

  const aSocket = c.connect(aServer.publicKey, {
    localConnection: false,
    relayThrough: bServer.publicKey
  })

  aSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, client side, client aborts hole punch', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const aServer = a.createServer({ shareLocalAddress: false }, function (socket) {
    lc.pass('server socket opened')
    socket
      .on('data', (data) => {
        lc.alike(data, Buffer.from('hello world'))
      })
      .on('close', () => {
        lc.pass('server socket closed')
      })
      .end()
  })

  await aServer.listen()

  const relay = new RelayServer({
    createStream (opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  const bServer = b.createServer({ shareLocalAddress: false }, function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await bServer.listen()

  const aSocket = c.connect(aServer.publicKey, {
    fastOpen: false,
    localConnection: false,
    holepunch: () => false,
    relayThrough: bServer.publicKey
  })

  aSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, client side, server aborts hole punch', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const aServer = a.createServer({ shareLocalAddress: false, holepunch: () => false }, function (socket) {
    lc.pass('server socket opened')
    socket
      .on('data', (data) => {
        lc.alike(data, Buffer.from('hello world'))
      })
      .on('close', () => {
        lc.pass('server socket closed')
      })
      .end()
  })

  await aServer.listen()

  const relay = new RelayServer({
    createStream (opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  const bServer = b.createServer({ shareLocalAddress: false }, function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await bServer.listen()

  const aSocket = c.connect(aServer.publicKey, {
    fastOpen: false,
    localConnection: false,
    relayThrough: bServer.publicKey
  })

  aSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, server side', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const relay = new RelayServer({
    createStream (opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  const aServer = a.createServer({ shareLocalAddress: false }, function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer({
    shareLocalAddress: false,
    relayThrough: aServer.publicKey
  }, function (socket) {
    lc.pass('server socket opened')
    socket
      .on('data', (data) => {
        lc.alike(data, Buffer.from('hello world'))
      })
      .on('close', () => {
        lc.pass('server socket closed')
      })
      .end()
  })

  await bServer.listen()

  const bSocket = c.connect(bServer.publicKey, {
    localConnection: false
  })

  bSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, server side, client aborts hole punch', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const relay = new RelayServer({
    createStream (opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  const aServer = a.createServer({ shareLocalAddress: false }, function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer({
    shareLocalAddress: false,
    relayThrough: aServer.publicKey
  }, function (socket) {
    lc.pass('server socket opened')
    socket
      .on('data', (data) => {
        lc.alike(data, Buffer.from('hello world'))
      })
      .on('close', () => {
        lc.pass('server socket closed')
      })
      .end()
  })

  await bServer.listen()

  const bSocket = c.connect(bServer.publicKey, {
    fastOpen: false,
    localConnection: false,
    holepunch: () => false
  })

  bSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, server side, server aborts hole punch', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const relay = new RelayServer({
    createStream (opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  const aServer = a.createServer({ shareLocalAddress: false }, function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer({
    shareLocalAddress: false,
    holepunch: () => false,
    relayThrough: aServer.publicKey
  }, function (socket) {
    lc.pass('server socket opened')
    socket
      .on('data', (data) => {
        lc.alike(data, Buffer.from('hello world'))
      })
      .on('close', () => {
        lc.pass('server socket closed')
      })
      .end()
  })

  await bServer.listen()

  const bSocket = c.connect(bServer.publicKey, {
    fastOpen: false,
    localConnection: false
  })

  bSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, client and server side', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const relay = new RelayServer({
    createStream (opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  const aServer = a.createServer({ shareLocalAddress: false }, function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer({
    shareLocalAddress: false,
    relayThrough: aServer.publicKey
  }, function (socket) {
    lc.pass('server socket opened')
    socket
      .on('data', (data) => {
        lc.alike(data, Buffer.from('hello world'))
      })
      .on('close', () => {
        lc.pass('server socket closed')
      })
      .end()
  })

  await bServer.listen()

  const bSocket = c.connect(bServer.publicKey, {
    fastOpen: false,
    localConnection: false,
    relayThrough: aServer.publicKey
  })

  bSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test.skip('relay several connections through node with pool', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(10)

  const aServer = a.createServer({ shareLocalAddress: false }, function (socket) {
    lc.pass('server socket opened')
    socket
      .on('data', (data) => {
        lc.alike(data, Buffer.from('hello world'))
      })
      .on('close', () => {
        lc.pass('server socket closed')
      })
      .end()
  })

  await aServer.listen()

  const relay = new RelayServer({
    createStream (opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  const bServer = b.createServer({ shareLocalAddress: false }, function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await bServer.listen()

  const pool = c.pool()

  const aSocket = c.connect(aServer.publicKey, {
    fastOpen: false,
    localConnection: false,
    relayThrough: bServer.publicKey,
    pool
  })

  aSocket
    .on('open', () => {
      lc.pass('1st client socket opened')
    })
    .on('close', () => {
      lc.pass('1st client socket closed')

      const aSocket = c.connect(aServer.publicKey, {
        fastOpen: false,
        localConnection: false,
        relayThrough: bServer.publicKey,
        pool
      })

      aSocket
        .on('open', () => {
          lc.pass('2nd client socket opened')
        })
        .on('close', () => {
          lc.pass('2nd client socket closed')
        })
        .end('hello world')
    })
    .end('hello world')

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test.skip('server does not support connection relaying', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(4)

  const aServer = a.createServer({ shareLocalAddress: false }, function () {
    t.fail()
  })

  await aServer.listen()

  const bServer = b.createServer({ shareLocalAddress: false }, function (socket) {
    lc.pass('server socket opened')
    socket.on('error', () => {
      lc.pass('server socket timed out')
    })
  })

  await bServer.listen()

  const aSocket = c.connect(aServer.publicKey, {
    fastOpen: false,
    localConnection: false,
    relayThrough: bServer.publicKey
  })

  aSocket.on('error', () => {
    lc.pass('client socket timed out')
  })

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test.solo('swarm server with relay', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap })
  const b = new DHT({ bootstrap })

  const relay = new RelayServer({
    createStream (opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  const aSwarm = new Hyperswarm({ dht: a })

  const aStore = new Corestore(RAM.reusable(), { passive: true })
  const aCore = aStore.get({ name: 'test' })
  await aCore.append(['a', 'b', 'c'])
  await aCore.close()

  aSwarm.on('connection', function (socket) {
    socket.on('error', (err) => t.comment(err.message))

    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))

    aStore.replicate(socket)
  })

  await aSwarm.listen()

  const bSocket = b.connect(aSwarm.server.publicKey, {
    fastOpen: false,
    localConnection: false,
    relayThrough: aSwarm.server.publicKey
  })

  const bStore = new Corestore(RAM)
  bStore.replicate(bSocket)

  const bCore = bStore.get({ key: aCore.key })
  t.alike(await bCore.get(1), Buffer.from('b'))

  await aStore.close()
  await bStore.close()

  await a.destroy()
  await b.destroy()
})
