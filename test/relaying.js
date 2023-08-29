const test = require('brittle')
const RelayServer = require('protomux-bridging-relay').Server
const { swarm } = require('./helpers')
const DHT = require('../')

test('relay connections through node, client side', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const aServer = a.createServer({
    shareLocalAddress: false,
    holepunch () {
      return false
    }
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

  await aServer.listen()

  const relay = new RelayServer({
    createStream (opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  const bServer = b.createServer({
    shareLocalAddress: false
  }, function (socket) {
    relay.accept(socket, { id: socket.remotePublicKey })
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

  const aServer = a.createServer({
    shareLocalAddress: false
  }, function (socket) {
    relay.accept(socket, { id: socket.remotePublicKey })
  })

  await aServer.listen()

  const bServer = b.createServer({
    shareLocalAddress: false,
    relayThrough: aServer.publicKey,
    holepunch () {
      return false
    }
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

  const aServer = a.createServer({
    shareLocalAddress: false
  }, function (socket) {
    relay.accept(socket, { id: socket.remotePublicKey })
  })

  await aServer.listen()

  const bServer = b.createServer({
    shareLocalAddress: false,
    relayThrough: aServer.publicKey,
    holepunch () {
      return false
    }
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

test('relay several connections through node with pool', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(10)

  const aServer = a.createServer({
    shareLocalAddress: false,
    holepunch () {
      return false
    }
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

  await aServer.listen()

  const relay = new RelayServer({
    createStream (opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  const bServer = b.createServer({
    shareLocalAddress: false
  }, function (socket) {
    relay.accept(socket, { id: socket.remotePublicKey })
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

test('server does not support connection relaying', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(3)

  const aServer = a.createServer({
    shareLocalAddress: false
  }, function () {
    t.fail()
  })

  await aServer.listen()

  const bServer = b.createServer({
    shareLocalAddress: false
  }, function (socket) {
    lc.pass('server socket opened')
    socket.on('close', () => {
      t.pass('server socket closed') // TODO Should close before `server.destroy()`
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
