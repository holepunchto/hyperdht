const test = require('brittle')
const { once } = require('events')
const BlindRelay = require('blind-relay')
const RelayServer = BlindRelay.Server
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const DHT = require('../')
const Holepuncher = require('../lib/holepuncher')
const { swarm, createDHT, endAndCloseSocket } = require('./helpers')

test('relay connections through node, client side', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

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
    createStream(opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const bServer = b.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
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

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, client side, client aborts hole punch', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

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
    createStream(opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const bServer = b.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
  })

  await bServer.listen()

  const aSocket = c.connect(aServer.publicKey, {
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

test('relay connections through node, server side, client abort notifies remote', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(6)
  let sawRelayStream = false

  const relay = new RelayServer({
    createStream(opts) {
      if (!sawRelayStream) {
        sawRelayStream = true
        lc.pass('sanity check: using the relay')
      }
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const aServer = a.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer(
    {
      relayThrough: aServer.publicKey,
      shareLocalAddress: false
    },
    function (socket) {
      lc.pass('server socket opened')
      socket
        .on('data', (data) => {
          lc.alike(data, Buffer.from('hello world'))
        })
        .on('close', () => {
          lc.pass('server socket closed')
        })
        .end()
    }
  )

  await bServer.listen()

  const remoteAbort = waitFor(() => bServer._holepunches.some((hs) => hs && hs.aborted))

  const bSocket = c.connect(bServer.publicKey, {
    fastOpen: false,
    localConnection: false,
    holepunch() {
      return false
    }
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
  await remoteAbort

  t.pass('remote records the client abort')

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

async function waitFor(fn, timeout = 2000) {
  const started = Date.now()

  while (!fn()) {
    if (Date.now() - started > timeout) {
      throw new Error('Timed out waiting for test condition')
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function getOnlyRelayPoolConnection(node) {
  const connections = [...node._relayPool._connections.values()]
  if (connections.length !== 1) throw new Error('Expected exactly one relay pool connection')
  return connections[0]
}

test('relay connections through node, client side, server aborts hole punch', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

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
    createStream(opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const bServer = b.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
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

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, server side', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const relay = new RelayServer({
    createStream(opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const aServer = a.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
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

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, server side, client aborts hole punch', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const relay = new RelayServer({
    createStream(opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const aServer = a.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
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

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, server side, server aborts hole punch', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)

  const relay = new RelayServer({
    createStream(opts) {
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const aServer = a.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer(
    { holepunch: () => false, relayThrough: aServer.publicKey },
    function (socket) {
      lc.pass('server socket opened')
      socket
        .on('data', (data) => {
          lc.alike(data, Buffer.from('hello world'))
        })
        .on('close', () => {
          lc.pass('server socket closed')
        })
        .end()
    }
  )

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

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

test('relay connections through node, client and server side', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({
    bootstrap,
    quickFirewall: false,
    ephemeral: true,
    connectionKeepAlive: 12345
  })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)
  const relayKeepAlive = t.test('relay keepalive')
  relayKeepAlive.plan(1)
  const testRelay = t.test('relay server')
  testRelay.plan(2) // One each for the initiator and the follower
  const testRelayInitiator = t.test('relay initiator')
  testRelayInitiator.plan(1)
  const testRelayFollower = t.test('relay follower')
  testRelayFollower.plan(1)

  const relay = new RelayServer({
    createStream(opts) {
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
    session.on('error', (err) => t.comment(err.message))
  })

  await aServer.listen()

  const bServer = b.createServer(
    {
      holepunch: false, // To ensure it relies only on relaying
      shareLocalAddress: false, // To help ensure it relies only on relaying (otherwise it can connect directly over LAN, without even trying to holepunch)
      relayThrough: aServer.publicKey,
      createSecretStream(isInitiator, rawStream, opts) {
        if (!isInitiator) {
          relayKeepAlive.is(
            opts.keepAlive,
            12345,
            'server relayed stream inherits connectionKeepAlive'
          )
        }

        return new NoiseSecretStream(isInitiator, rawStream, opts)
      }
    },
    function (socket) {
      lc.pass('server socket opened')
      socket
        .on('data', (data) => {
          lc.alike(data, Buffer.from('hello world'))
        })
        .on('close', () => {
          lc.pass('server socket closed')
        })
        .end()
    }
  )

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

  await lc
  await relayKeepAlive

  await c.destroy()
  await b.destroy()
  await a.destroy()
})

test('relay connections through same node reuse transport sockets', async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap })
  const serverNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const relaySockets = []
  let closedRelaySockets = 0
  let resolveRelaySockets = null
  const relaySocketsOpened = new Promise((resolve) => {
    resolveRelaySockets = resolve
  })

  let firstServerSocket = null
  let secondServerSocket = null
  let reconnectedServerSocket = null

  const relay = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const relayStreams = []
  let closedRelayStreams = 0
  let resolveRelayStreamsPaired = null
  const relayStreamsPaired = new Promise((resolve) => {
    resolveRelayStreamsPaired = resolve
  })
  let resolveFirstPairingReleased = null
  const firstPairingReleased = new Promise((resolve) => {
    resolveFirstPairingReleased = resolve
  })

  const relayTransportServer = relayNode.createServer(function (socket) {
    relaySockets.push(socket)
    socket.once('close', function () {
      closedRelaySockets++
    })
    // Wait until both peers have opened their shared relay transport sockets.
    if (relaySockets.length === 2) resolveRelaySockets()

    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('pair', function (_, __, stream) {
      relayStreams.push(stream)
      if (relayStreams.length === 4) resolveRelayStreamsPaired()

      stream.once('close', function () {
        closedRelayStreams++
        if (closedRelayStreams === 2) resolveFirstPairingReleased()
      })
    })
    session.on('error', (err) => t.comment(err.message))
  })

  await relayTransportServer.listen()

  const appServer = serverNode.createServer(
    {
      holepunch: false,
      shareLocalAddress: false,
      relayThrough: relayTransportServer.publicKey
    },
    function (socket) {
      if (firstServerSocket === null) firstServerSocket = socket
      else if (secondServerSocket === null) secondServerSocket = socket
      else reconnectedServerSocket = socket

      socket.on('data', (data) => socket.write(data))
      socket.on('end', () => socket.end())
    }
  )

  await appServer.listen()

  const firstClientSocket = clientNode.connect(appServer.publicKey, {
    localConnection: false,
    relayThrough: relayTransportServer.publicKey
  })
  await once(firstClientSocket, 'open')

  const secondClientSocket = clientNode.connect(appServer.publicKey, {
    localConnection: false,
    relayThrough: relayTransportServer.publicKey
  })
  await once(secondClientSocket, 'open')

  await Promise.all([relaySocketsOpened, relayStreamsPaired])

  t.is(relaySockets.length, 2, 'both peers reuse one transport socket to the relay')

  const firstReply = once(firstClientSocket, 'data')
  const secondReply = once(secondClientSocket, 'data')
  firstClientSocket.write(Buffer.from('hello 1'))
  secondClientSocket.write(Buffer.from('hello 2'))

  t.alike(await firstReply, [Buffer.from('hello 1')], 'first relayed connection carries data')
  t.alike(await secondReply, [Buffer.from('hello 2')], 'second relayed connection carries data')

  const firstServerClosed = once(firstServerSocket, 'close')
  await endAndCloseSocket(firstClientSocket)
  await firstServerClosed
  await firstPairingReleased
  t.is(closedRelayStreams, 2, 'closing one app connection releases only its relay pairing')

  const afterFirstClosedReply = once(secondClientSocket, 'data')
  secondClientSocket.write(Buffer.from('still relayed'))
  t.alike(
    await afterFirstClosedReply,
    [Buffer.from('still relayed')],
    'second relayed connection stays usable after first closes'
  )

  await endAndCloseSocket(secondClientSocket)

  if (!secondServerSocket.destroyed) await once(secondServerSocket, 'close')

  await waitFor(() => closedRelaySockets === 2)
  t.is(closedRelaySockets, 2, 'shared relay transports close after all pairings close')

  const reconnectedServerSocketOpened = waitFor(() => reconnectedServerSocket !== null)
  const reconnectedClientSocket = clientNode.connect(appServer.publicKey, {
    localConnection: false,
    relayThrough: relayTransportServer.publicKey
  })

  await Promise.all([once(reconnectedClientSocket, 'open'), reconnectedServerSocketOpened])
  await waitFor(() => relaySockets.length === 4)
  t.is(relaySockets.length, 4, 'reconnect creates fresh relay transport sockets')

  const reconnectedReply = once(reconnectedClientSocket, 'data')
  reconnectedClientSocket.write(Buffer.from('reconnected'))
  t.alike(
    await reconnectedReply,
    [Buffer.from('reconnected')],
    'reconnected relay path carries data'
  )

  await endAndCloseSocket(reconnectedClientSocket)
  if (!reconnectedServerSocket.destroyed) await once(reconnectedServerSocket, 'close')

  await clientNode.destroy()
  await serverNode.destroy()
  await relayNode.destroy()
})

test('relay pool closes app streams when shared transports close', async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap })
  const serverNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const relaySockets = []
  let resolveRelaySockets = null
  const relaySocketsOpened = new Promise((resolve) => {
    resolveRelaySockets = resolve
  })

  const serverSockets = []
  let resolveServerSockets = null
  const serverSocketsOpened = new Promise((resolve) => {
    resolveServerSockets = resolve
  })

  const relay = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const relayTransportServer = relayNode.createServer(function (socket) {
    relaySockets.push(socket)
    if (relaySockets.length === 2) resolveRelaySockets()

    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', () => {})
  })

  await relayTransportServer.listen()

  const appServer = serverNode.createServer(
    {
      holepunch: false,
      shareLocalAddress: false,
      relayThrough: relayTransportServer.publicKey
    },
    function (socket) {
      serverSockets.push(socket)
      if (serverSockets.length === 2) resolveServerSockets()

      socket.on('data', (data) => socket.write(data))
      socket.on('end', () => socket.end())
    }
  )

  await appServer.listen()

  const clientSockets = [
    clientNode.connect(appServer.publicKey, {
      localConnection: false,
      relayThrough: relayTransportServer.publicKey
    }),
    clientNode.connect(appServer.publicKey, {
      localConnection: false,
      relayThrough: relayTransportServer.publicKey
    })
  ]

  await Promise.all([
    relaySocketsOpened,
    serverSocketsOpened,
    ...clientSockets.map((socket) => once(socket, 'open'))
  ])

  t.is(clientNode._relayPool._connections.size, 1, 'client has one shared relay pool connection')
  t.is(serverNode._relayPool._connections.size, 1, 'server has one shared relay pool connection')

  const closed = [
    ...clientSockets.map((socket) => once(socket, 'close')),
    ...serverSockets.map((socket) => once(socket, 'close'))
  ]

  getOnlyRelayPoolConnection(clientNode).socket.destroy()
  getOnlyRelayPoolConnection(serverNode).socket.destroy()

  await Promise.all(closed)
  t.pass('active app streams close when shared relay transports close')
  t.is(clientNode._relayPool._connections.size, 0, 'client relay pool connection is removed')
  t.is(serverNode._relayPool._connections.size, 0, 'server relay pool connection is removed')

  const reconnectedServerSocket = waitFor(() => serverSockets.length === 3)
  const reconnectedClientSocket = clientNode.connect(appServer.publicKey, {
    localConnection: false,
    relayThrough: relayTransportServer.publicKey
  })

  await Promise.all([once(reconnectedClientSocket, 'open'), reconnectedServerSocket])
  await waitFor(() => relaySockets.length === 4)
  t.is(relaySockets.length, 4, 'later reconnect creates fresh relay transports')

  const reply = once(reconnectedClientSocket, 'data')
  reconnectedClientSocket.write(Buffer.from('fresh relay'))
  t.alike((await reply)[0], Buffer.from('fresh relay'), 'fresh relay transport carries data')

  await endAndCloseSocket(reconnectedClientSocket)
  const lastServerSocket = serverSockets[serverSockets.length - 1]
  if (!lastServerSocket.destroyed) await once(lastServerSocket, 'close')

  await clientNode.destroy()
  await serverNode.destroy()
  await relayNode.destroy()
})

test('relay pool unpairs if pairing aborts before remote pairs', async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const relay = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const relayTransportServer = relayNode.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
  })

  await relayTransportServer.listen()

  const rawStream = clientNode.createRawStream({ framed: true })
  const pairing = clientNode._relayPool.pair(relayTransportServer.publicKey, {
    isInitiator: true,
    token: BlindRelay.token(),
    stream: rawStream,
    keepAlive: 5000
  })

  await waitFor(() => relay._pairing.size === 1)
  t.is(relay._pairing.size, 1, 'relay has one pending half-pairing')

  pairing.release()
  rawStream.destroy()

  await waitFor(() => relay._pairing.size === 0)
  await waitFor(() => clientNode._relayPool._connections.size === 0)
  t.is(relay._pairing.size, 0, 'pending half-pairing is unpaired')
  t.is(clientNode._relayPool._connections.size, 0, 'relay pool closes after aborted pairing')

  await clientNode.destroy()
  await relayNode.destroy()
})

test('relay pool does not reuse closing transport sockets', async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const relay = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const relayTransportServer = relayNode.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
  })

  await relayTransportServer.listen()

  const firstStream = clientNode.createRawStream({ framed: true })
  const firstPairing = clientNode._relayPool.pair(relayTransportServer.publicKey, {
    isInitiator: true,
    token: BlindRelay.token(),
    stream: firstStream,
    keepAlive: 5000
  })
  const closingSocket = firstPairing.socket

  // Simulate the close-event race where the pool connection still exists but its transport is closing.
  closingSocket.destroy()

  const secondStream = clientNode.createRawStream({ framed: true })
  const secondPairing = clientNode._relayPool.pair(relayTransportServer.publicKey, {
    isInitiator: true,
    token: BlindRelay.token(),
    stream: secondStream,
    keepAlive: 5000
  })

  t.not(secondPairing.socket, closingSocket, 'new pairing gets a fresh relay transport')

  firstStream.destroy()
  secondStream.destroy()
  secondPairing.release()

  await clientNode.destroy()
  await relayNode.destroy()
})

test('relay pool reuses transport and takes lowest relay keepalive', async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const relay = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const relayTransportServer = relayNode.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
  })

  await relayTransportServer.listen()

  const pairings = []

  function pair(keepAlive) {
    const stream = clientNode.createRawStream({ framed: true })
    const pairing = clientNode._relayPool.pair(relayTransportServer.publicKey, {
      isInitiator: true,
      token: BlindRelay.token(),
      stream,
      keepAlive
    })

    pairings.push({ pairing, stream })
    return pairing
  }

  const firstPairing = pair(30000)
  const firstSocket = firstPairing.socket

  const secondPairing = pair(1000)

  t.is(secondPairing.socket, firstSocket, 'different keepalive values reuse transport')
  t.is(firstSocket.keepAlive, 1000, 'shared transport takes lower keepalive')
  t.is(clientNode._relayPool._connections.size, 1, 'different keepalive values use one connection')

  const thirdPairing = pair(30000)

  t.is(thirdPairing.socket, firstSocket, 'higher keepalive value reuses transport')
  t.is(firstSocket.keepAlive, 1000, 'shared transport keeps lower keepalive')
  t.is(
    clientNode._relayPool._connections.size,
    1,
    'higher keepalive value reuses existing connection'
  )

  for (const { pairing, stream } of pairings) {
    pairing.release()
    stream.destroy()
  }

  await clientNode.destroy()
  await relayNode.destroy()
})

test('relay pool unrefs and clears delayed direct-upgrade unpairs', async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const relay = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const relayTransportServer = relayNode.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
  })

  await relayTransportServer.listen()

  const rawStream = clientNode.createRawStream({ framed: true })
  const pairing = clientNode._relayPool.pair(relayTransportServer.publicKey, {
    isInitiator: true,
    token: BlindRelay.token(),
    stream: rawStream,
    keepAlive: 5000
  })

  await waitFor(() => relay._pairing.size === 1)

  // closePairing is the direct-upgrade cleanup path that schedules delayed unpair.
  const connection = pairing.connection
  pairing.closePairing()
  rawStream.destroy()

  t.is(connection.pendingReleaseTimers.size, 1, 'delayed unpair timer is added')
  const [timer] = connection.pendingReleaseTimers
  t.absent(timer.hasRef(), 'delayed unpair timer is unrefed')

  await clientNode._relayPool.destroy()
  t.is(connection.pendingReleaseTimers.size, 0, 'delayed unpair timer is cleared on pool destroy')

  await clientNode.destroy()
  await relayNode.destroy()
})

test('relay pool keeps transport open for pairings started during delayed unpair', async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const relay = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const relayTransportServer = relayNode.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
  })

  await relayTransportServer.listen()

  const firstStream = clientNode.createRawStream({ framed: true })
  const firstPairing = clientNode._relayPool.pair(relayTransportServer.publicKey, {
    isInitiator: true,
    token: BlindRelay.token(),
    stream: firstStream,
    keepAlive: 5000
  })

  await waitFor(() => relay._pairing.size === 1)

  const relaySocket = firstPairing.socket
  const relayConnection = firstPairing.connection

  // Simulate direct upgrade for the first pairing with a shorter delayed unpair.
  firstPairing._release(true, 1000)
  firstStream.destroy()

  t.is(relayConnection.pendingReleaseTimers.size, 1, 'first pairing schedules delayed unpair')

  const secondStream = clientNode.createRawStream({ framed: true })
  const secondPairing = clientNode._relayPool.pair(relayTransportServer.publicKey, {
    isInitiator: true,
    token: BlindRelay.token(),
    stream: secondStream,
    keepAlive: 5000
  })

  t.is(secondPairing.socket, relaySocket, 'new pairing reuses the pending relay transport')

  await waitFor(() => relay._pairing.size === 2)
  // The delayed unpair should remove only the first pairing.
  await waitFor(() => relay._pairing.size === 1)
  t.is(clientNode._relayPool._connections.size, 1, 'pool connection stays open for the new pairing')
  t.is(
    getOnlyRelayPoolConnection(clientNode).socket,
    relaySocket,
    'same relay transport remains pooled'
  )
  t.absent(relaySocket.destroying, 'relay transport is not closing')

  secondPairing.release()
  secondStream.destroy()

  await clientNode._relayPool.destroy()
  await waitFor(() => clientNode._relayPool._connections.size === 0)

  await clientNode.destroy()
  await relayNode.destroy()
})

test('relay connection upgrades to direct connection', async function (t) {
  for (const opts of [
    { name: 'default keepalive' },
    { name: 'without keepalive', connectionKeepAlive: false, confirmWithAppData: true },
    { name: 'idle without keepalive', connectionKeepAlive: false }
  ]) {
    t.comment(opts.name)
    const { bootstrap } = await swarm(t)

    const relayNode = createDHT({ bootstrap })
    const serverNode = createDHT({
      bootstrap,
      quickFirewall: false,
      ephemeral: true,
      connectionKeepAlive: opts.connectionKeepAlive
    })
    const clientNode = createDHT({
      bootstrap,
      quickFirewall: false,
      ephemeral: true,
      connectionKeepAlive: opts.connectionKeepAlive
    })

    const resumePunching = pausePunching(t, [serverNode, clientNode])

    const relayServer = new RelayServer({
      createStream(opts) {
        return relayNode.createRawStream({ ...opts, framed: true })
      }
    })

    t.teardown(() => relayServer.close())

    const relaySockets = []
    let resolveRelaySockets = null
    const relaySocketsOpened = new Promise((resolve) => {
      resolveRelaySockets = resolve
    })

    const relayTransportServer = relayNode.createServer(function (socket) {
      relaySockets.push(socket)
      // Wait until both client and server have opened their relay transport sockets.
      if (relaySockets.length === 2) resolveRelaySockets(relaySockets)

      const session = relayServer.accept(socket, { id: socket.remotePublicKey })
      session.on('error', (err) => t.comment(err.message))
    })

    await relayTransportServer.listen()

    let resolveServerSocket = null
    const serverSocketOpened = new Promise((resolve) => {
      resolveServerSocket = resolve
    })

    const appServer = serverNode.createServer(
      {
        relayThrough: relayTransportServer.publicKey,
        shareLocalAddress: false
      },
      function (socket) {
        resolveServerSocket(socket)

        socket.on('data', (data) => socket.write(data))
        socket.on('end', () => socket.end())
      }
    )

    await appServer.listen()

    const clientSocket = clientNode.connect(appServer.publicKey, {
      fastOpen: false,
      localConnection: false
    })

    const [serverSocket] = await Promise.all([serverSocketOpened, once(clientSocket, 'open')])
    await relaySocketsOpened

    t.is(relaySockets.length, 2, 'both peers opened relay transport sockets')

    t.not(
      serverSocket.rawStream.remotePort,
      clientSocket.rawStream.localPort,
      'server starts on the relayed stream'
    )
    t.not(
      clientSocket.rawStream.remotePort,
      serverSocket.rawStream.localPort,
      'client starts on the relayed stream'
    )

    // The relayed connection should already be usable before the direct path wins.
    const beforeUpgrade = once(clientSocket, 'data')
    clientSocket.write(Buffer.from('before upgrade'))
    t.alike((await beforeUpgrade)[0], Buffer.from('before upgrade'), 'relay path carries data')

    const clientUpgraded = once(clientSocket.rawStream, 'remote-changed')
    const serverUpgraded = once(serverSocket.rawStream, 'remote-changed')
    const relaySocketsClosed = relaySockets.map((socket) => once(socket, 'close'))

    resumePunching()

    if (opts.confirmWithAppData) {
      await clientUpgraded

      t.ok(
        relaySockets.every((socket) => !socket.destroyed),
        'relay stays open until direct traffic confirms the upgrade'
      )

      // Without keepalive, the passive upgrade is confirmed by the next app write.
      const appData = once(clientSocket, 'data')
      clientSocket.write(Buffer.from('after upgrade'))
      t.alike((await appData)[0], Buffer.from('after upgrade'), 'app data confirms direct path')
    }

    await Promise.all([clientUpgraded, serverUpgraded])
    await Promise.all(relaySocketsClosed)
    t.pass('relay transport sockets close after direct upgrade')

    t.is(
      serverSocket.rawStream.remotePort,
      clientSocket.rawStream.localPort,
      'server switches to the client address'
    )
    t.is(
      clientSocket.rawStream.remotePort,
      serverSocket.rawStream.localPort,
      'client switches to the server address'
    )

    if (!opts.confirmWithAppData) {
      const afterUpgrade = once(clientSocket, 'data')
      clientSocket.write(Buffer.from('after upgrade'))
      t.alike((await afterUpgrade)[0], Buffer.from('after upgrade'), 'direct path carries data')
    }

    await endAndCloseSocket(clientSocket)
    if (!serverSocket.destroyed) await once(serverSocket, 'close')

    await relayNode.destroy()
    await serverNode.destroy()
    await clientNode.destroy()
  }
})

test('direct upgrade keeps other pooled relay pairings alive', async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap })
  const serverNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const resumePunching = pausePunching(t, [serverNode, clientNode])

  const relayServer = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relayServer.close())

  const relaySockets = []
  let closedRelaySockets = 0
  let resolveRelaySockets = null
  const relaySocketsOpened = new Promise((resolve) => {
    resolveRelaySockets = resolve
  })

  const relayStreams = []
  let closedRelayStreams = 0
  let resolveRelayStreamsPaired = null
  const relayStreamsPaired = new Promise((resolve) => {
    resolveRelayStreamsPaired = resolve
  })

  const relayTransportServer = relayNode.createServer(function (socket) {
    relaySockets.push(socket)
    socket.once('close', function () {
      closedRelaySockets++
    })
    if (relaySockets.length === 2) resolveRelaySockets()

    const session = relayServer.accept(socket, { id: socket.remotePublicKey })
    session.on('pair', function (_, __, stream) {
      relayStreams.push(stream)
      if (relayStreams.length === 4) resolveRelayStreamsPaired()

      stream.once('close', function () {
        closedRelayStreams++
      })
    })
    session.on('error', (err) => t.comment(err.message))
  })

  await relayTransportServer.listen()

  let resolveUpgradeServerSocket = null
  const upgradeServerSocketOpened = new Promise((resolve) => {
    resolveUpgradeServerSocket = resolve
  })
  const upgradeServer = serverNode.createServer(
    {
      relayThrough: relayTransportServer.publicKey,
      shareLocalAddress: false
    },
    function (socket) {
      socket.on('error', (err) => t.comment(err.message))
      resolveUpgradeServerSocket(socket)
      socket.on('data', (data) => socket.write(data))
      socket.on('end', () => socket.end())
    }
  )

  await upgradeServer.listen(DHT.keyPair())

  let resolveRelayOnlyServerSocket = null
  const relayOnlyServerSocketOpened = new Promise((resolve) => {
    resolveRelayOnlyServerSocket = resolve
  })
  const relayOnlyServer = serverNode.createServer(
    {
      relayThrough: relayTransportServer.publicKey,
      shareLocalAddress: false
    },
    function (socket) {
      socket.on('error', (err) => t.comment(err.message))
      resolveRelayOnlyServerSocket(socket)
      socket.on('data', (data) => socket.write(data))
      socket.on('end', () => socket.end())
    }
  )

  await relayOnlyServer.listen(DHT.keyPair())

  const upgradeClientSocket = clientNode.connect(upgradeServer.publicKey, {
    fastOpen: false,
    localConnection: false
  })
  const relayOnlyClientSocket = clientNode.connect(relayOnlyServer.publicKey, {
    fastOpen: false,
    holepunch: () => false,
    localConnection: false
  })
  upgradeClientSocket.on('error', (err) => t.comment(err.message))
  relayOnlyClientSocket.on('error', (err) => t.comment(err.message))

  const [upgradeServerSocket, relayOnlyServerSocket] = await Promise.all([
    upgradeServerSocketOpened,
    relayOnlyServerSocketOpened,
    once(upgradeClientSocket, 'open'),
    once(relayOnlyClientSocket, 'open')
  ])
  await Promise.all([relaySocketsOpened, relayStreamsPaired])

  t.is(relaySockets.length, 2, 'both app connections share the relay transport sockets')
  t.is(clientNode._relayPool._connections.size, 1, 'client has one shared relay pool connection')
  t.is(serverNode._relayPool._connections.size, 1, 'server has one shared relay pool connection')

  const beforeUpgrade = once(relayOnlyClientSocket, 'data')
  relayOnlyClientSocket.write(Buffer.from('before direct upgrade'))
  t.alike(
    (await beforeUpgrade)[0],
    Buffer.from('before direct upgrade'),
    'relay-only connection carries data before another pairing upgrades'
  )

  let relayOnlyClientUpgraded = false
  let relayOnlyServerUpgraded = false
  relayOnlyClientSocket.rawStream.once('remote-changed', () => {
    relayOnlyClientUpgraded = true
  })
  relayOnlyServerSocket.rawStream.once('remote-changed', () => {
    relayOnlyServerUpgraded = true
  })

  const clientUpgraded = once(upgradeClientSocket.rawStream, 'remote-changed')
  const serverUpgraded = once(upgradeServerSocket.rawStream, 'remote-changed')

  resumePunching()
  await Promise.all([clientUpgraded, serverUpgraded])
  await waitFor(() => closedRelayStreams === 2, 12000)

  t.is(closedRelayStreams, 2, 'direct upgrade releases only its relay pairing')
  t.is(closedRelaySockets, 0, 'shared relay transports stay open for the other pairing')
  t.absent(relayOnlyClientUpgraded, 'relay-only client does not upgrade to direct')
  t.absent(relayOnlyServerUpgraded, 'relay-only server does not upgrade to direct')
  t.not(
    relayOnlyServerSocket.rawStream.remotePort,
    relayOnlyClientSocket.rawStream.localPort,
    'relay-only server stays on the relayed stream'
  )
  t.not(
    relayOnlyClientSocket.rawStream.remotePort,
    relayOnlyServerSocket.rawStream.localPort,
    'relay-only client stays on the relayed stream'
  )

  const directReply = once(upgradeClientSocket, 'data')
  upgradeClientSocket.write(Buffer.from('after direct upgrade'))
  t.alike(
    (await directReply)[0],
    Buffer.from('after direct upgrade'),
    'upgraded direct connection carries data'
  )

  const relayedReply = once(relayOnlyClientSocket, 'data')
  relayOnlyClientSocket.write(Buffer.from('still relayed'))
  t.alike(
    (await relayedReply)[0],
    Buffer.from('still relayed'),
    'other pooled relay pairing stays usable after direct upgrade'
  )

  await endAndCloseSocket(upgradeClientSocket)
  if (!upgradeServerSocket.destroyed) await once(upgradeServerSocket, 'close')

  await endAndCloseSocket(relayOnlyClientSocket)
  if (!relayOnlyServerSocket.destroyed) await once(relayOnlyServerSocket, 'close')

  await waitFor(() => closedRelaySockets === 2, 12000)
  t.is(closedRelaySockets, 2, 'shared relay transports close after remaining pairing closes')

  await relayNode.destroy()
  await serverNode.destroy()
  await clientNode.destroy()
})

test.skip('relay several connections through node with pool', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(10)

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
    createStream(opts) {
      return b.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const bServer = b.createServer(function (socket) {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
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
    })
    .end('hello world')

  await lc

  await a.destroy()
  await b.destroy()
  await c.destroy()
})

function pausePunching(t, pausedNodes) {
  const punch = Holepuncher.prototype._punch
  let resume = null
  const punchingResumed = new Promise((resolve) => {
    resume = resolve
  })

  Holepuncher.prototype._punch = async function () {
    if (pausedNodes.includes(this.dht)) await punchingResumed
    return punch.call(this)
  }

  t.teardown(() => {
    resume()
    Holepuncher.prototype._punch = punch
  })

  return resume
}

test.skip('server does not support connection relaying', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

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
