const test = require('brittle')
const RelayServer = require('blind-relay').Server
const { swarm } = require('./helpers')
const DHT = require('../')

test('relay connections through node, client side', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(7)

  const aServer = a.createServer(function (socket) {
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

  t.teardown(() => relay.close())

  const bServer = b.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await bServer.listen()

  const aSocket = c.connect(aServer.publicKey, { relayThrough: bServer.publicKey })

  aSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  aSocket.relay.on('abort', () => {
    lc.pass('relay aborted')
    lc.is(aSocket.relay.relaying, false)
  })
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
  lc.plan(6)

  const aServer = a.createServer(function (socket) {
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

  t.teardown(() => relay.close())

  const bServer = b.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await bServer.listen()

  const aSocket = c.connect(aServer.publicKey, { holepunch: () => false, relayThrough: bServer.publicKey })

  aSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  aSocket.relay.on('abort', () => {
    lc.pass('client relay aborted')
  })

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
  lc.plan(6)

  const aServer = a.createServer({ holepunch: () => false }, function (socket) {
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

  t.teardown(() => relay.close())

  const bServer = b.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await bServer.listen()

  const aSocket = c.connect(aServer.publicKey, { relayThrough: bServer.publicKey })

  aSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  aSocket.relay.on('abort', () => {
    lc.pass('client relay aborted')
  })

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
  lc.plan(6)

  const relay = new RelayServer({
    createStream (opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const aServer = a.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer({ relayThrough: aServer.publicKey }, function (socket) {
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

  const bSocket = c.connect(bServer.publicKey)

  bSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  bSocket.relay.on('abort', () => {
    lc.pass('client relay aborted')
  })

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
  lc.plan(6)

  const relay = new RelayServer({
    createStream (opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const aServer = a.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer({ relayThrough: aServer.publicKey }, function (socket) {
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

  const bSocket = c.connect(bServer.publicKey, { holepunch: () => false })

  bSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  bSocket.relay.on('abort', () => {
    lc.pass('client relay aborted')
  })

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
  lc.plan(6)

  const relay = new RelayServer({
    createStream (opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const aServer = a.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer({ holepunch: () => false, relayThrough: aServer.publicKey }, function (socket) {
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

  const bSocket = c.connect(bServer.publicKey)

  bSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  bSocket.relay.on('abort', () => {
    lc.pass('client relay aborted')
  })

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
  lc.plan(9)
  const testRelay = t.test('relay server')
  testRelay.plan(2) // One each for the initiator and the follower
  const testRelayInitiator = t.test('relay initiator')
  testRelayInitiator.plan(1)
  const testRelayFollower = t.test('relay follower')
  testRelayFollower.plan(1)

  const relay = new RelayServer({
    createStream (opts) {
      testRelay.pass('The relay server created a relay stream')
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const aServer = a.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('pair', (isInitiator) => {
      if (isInitiator) {
        testRelayInitiator.pass('The initiator paired with the relay server')
      } else {
        testRelayFollower.pass('The non-iniator paired with the relay server')
      }
    })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer({
    holepunch: false, // To ensure it relies only on relaying
    shareLocalAddress: false, // To help ensure it relies only on relaying (otherwise it can connect directly over LAN, without even trying to holepunch)
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

  const bSocket = c.connect(bServer.publicKey, { relayThrough: aServer.publicKey })

  bSocket
    .on('open', () => {
      lc.pass('client socket opened')
    })
    .on('close', () => {
      lc.pass('client socket closed')
    })
    .end('hello world')

  bSocket.relay
    .on('relay', () => {
      lc.pass('client socket is being relayed')
      lc.is(bSocket.relay.relaying, true)
      lc.alike(bSocket.relay.remotePublicKey, bServer.publicKey)
      lc.alike(bSocket.relay.relayThrough, aServer.publicKey)
    })
    .on('abort', () => {
      lc.fail('client relay aborted')
    })

  await lc

  await c.destroy()
  await b.destroy()
  await a.destroy()
})

test.skip('relay several connections through node with pool', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(12)

  const aServer = a.createServer(function (socket) {
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

  t.teardown(() => relay.close())

  const bServer = b.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session
      .on('error', (err) => t.comment(err.message))
  })

  await bServer.listen()

  const pool = c.pool()

  const aSocket = c.connect(aServer.publicKey, { relayThrough: bServer.publicKey, pool })

  aSocket
    .on('open', () => {
      lc.pass('1st client socket opened')
    })
    .on('close', () => {
      lc.pass('1st client socket closed')

      const aSocket = c.connect(aServer.publicKey, { relayThrough: bServer.publicKey, pool })

      aSocket
        .on('open', () => {
          lc.pass('2nd client socket opened')
        })
        .on('close', () => {
          lc.pass('2nd client socket closed')
        })
        .end('hello world')

      aSocket.relay.on('abort', () => {
        lc.pass('2nd client relay aborted')
      })
    })
    .end('hello world')

  aSocket.relay.on('abort', () => {
    lc.pass('1st client relay aborted')
  })

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

  const aServer = a.createServer(function () {
    t.fail()
  })

  await aServer.listen()

  const bServer = b.createServer(function (socket) {
    lc.pass('server socket opened')
    socket.on('error', () => {
      lc.pass('server socket timed out')
    })
  })

  await bServer.listen()

  const aSocket = c.connect(aServer.publicKey, { relayThrough: bServer.publicKey })

  aSocket.on('error', () => {
    lc.pass('client socket timed out')
  })

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})
