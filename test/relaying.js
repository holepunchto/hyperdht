const test = require('brittle')
const b4a = require('b4a')
const { once } = require('events')
const RelayServer = require('blind-relay').Server
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const Holepuncher = require('../lib/holepuncher')
const { swarm, createDHT, endAndCloseSocket } = require('./helpers')

test('relay connections through node, client side', async function (t) {
  const { bootstrap } = await swarm(t)

  const a = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  t.teardown(() => Promise.all([a.destroy(), b.destroy(), c.destroy()]))

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

  // Application-stream closure can precede relay cleanup.
  const relayConnection = aServer._relayConnection
  const relayClosed = new Promise((resolve) => {
    aServer._relayConnection = function (hs, ...args) {
      this._relayConnection = relayConnection
      relayConnection.call(this, hs, ...args)
      resolve(Promise.all([closed(hs.relaySocket), closed(hs.relayClient)]))
    }
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

  await relayClosed
  t.is(a.stats.relaying.aborts, 0, 'no relay abort when the direct path wins')

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

function closed(stream) {
  return new Promise((resolve) => stream.once('close', resolve))
}

function handshakeCleared(server, hs) {
  const clear = server._clear

  return new Promise((resolve) => {
    server._clear = function (...args) {
      const result = clear.apply(this, args)
      if (args[0] === hs) {
        server._clear = clear
        resolve()
      }
      return result
    }
  })
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

test('relay connection upgrades to direct connection', async function (t) {
  for (const opts of [
    { name: 'default keepalive' },
    { name: 'without keepalive', connectionKeepAlive: false, confirmWithAppData: true },
    { name: 'idle without keepalive', connectionKeepAlive: false },
    {
      name: 'server relay loss during non-punching probe',
      connectionKeepAlive: false,
      relayFailure: true
    },
    {
      name: 'server relay loss past deadline during a punching request',
      connectionKeepAlive: false,
      relayFailure: true,
      remoteHolepunching: true,
      relayRecoveryWait: 100,
      waitForRecoveryExpiry: true
    }
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
    t.teardown(() => Promise.all([relayNode.destroy(), serverNode.destroy(), clientNode.destroy()]))

    const resumePunching = pausePunching(t, [serverNode, clientNode])
    const pausedAnalysis = opts.relayFailure
      ? pauseAnalysis(t, serverNode, {
          remoteHolepunching: !!opts.remoteHolepunching,
          bypassAnalysis: true
        })
      : null
    let relayFailureHandshake = null

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
      if (opts.relayFailure) socket.on('error', () => {})
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
        shareLocalAddress: false,
        relayRecoveryWait: opts.relayRecoveryWait
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
    const relaySocketsClosed = relaySockets.map((socket) =>
      opts.relayFailure ? closed(socket) : once(socket, 'close')
    )

    if (pausedAnalysis) {
      const puncher = await pausedAnalysis.active
      const hs = appServer._holepunches.find((h) => h && h.relayPaired && h.puncher === puncher)

      if (!hs) throw new Error('Missing paired server handshake')
      relayFailureHandshake = hs

      const relaySocket = hs.relaySocket
      const relaySocketClosed = closed(relaySocket)

      relaySocket.destroy()
      await relaySocketClosed

      if (opts.waitForRecoveryExpiry) {
        // This case must cross the actual recovery deadline with a request in flight.
        await new Promise((resolve) => setTimeout(resolve, appServer.relayRecoveryWait * 1.2))
      }

      pausedAnalysis.resume()
    }

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

    if (relayFailureHandshake && !opts.waitForRecoveryExpiry) {
      t.is(
        relayFailureHandshake.relayRecoveryTimeout,
        null,
        'server clears the recovery timer after direct upgrade'
      )
    }

    await Promise.all(relaySocketsClosed)
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

test('relayed connection still upgrades when the client pauses between rounds', async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap })
  const serverNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  t.teardown(() => Promise.all([relayNode.destroy(), serverNode.destroy(), clientNode.destroy()]))

  // Model a client waiting for its random-punch budget between rounds.
  const pausedAnalysis = pauseAnalysis(t, clientNode)

  const relayServer = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })
  t.teardown(() => relayServer.close())

  const relayTransportServer = relayNode.createServer(function (socket) {
    socket.on('error', () => {})
    relayServer.accept(socket, { id: socket.remotePublicKey }).on('error', () => {})
  })
  await relayTransportServer.listen()

  const appServer = serverNode.createServer(
    {
      relayThrough: relayTransportServer.publicKey,
      shareLocalAddress: false,
      relayRecoveryWait: 100
    },
    function (socket) {
      socket.on('error', () => {})
      socket.on('end', () => socket.end())
    }
  )
  await appServer.listen()

  const connection = once(appServer, 'connection')
  const clientSocket = clientNode.connect(appServer.publicKey, {
    fastOpen: false,
    localConnection: false
  })
  clientSocket.on('error', () => {})

  const [[serverSocket]] = await Promise.all([
    connection,
    once(clientSocket, 'open'),
    pausedAnalysis.active
  ])

  t.not(
    clientSocket.rawStream.remotePort,
    serverSocket.rawStream.localPort,
    'client starts on the relayed stream'
  )

  const upgraded = Promise.all([
    once(clientSocket.rawStream, 'remote-changed'),
    once(serverSocket.rawStream, 'remote-changed')
  ])

  // Keep the healthy relay idle beyond the recovery grace before resuming.
  await new Promise((resolve) => setTimeout(resolve, appServer.relayRecoveryWait * 2))
  t.absent(serverSocket.rawStream.destroyed, 'healthy relay survives the quiet period')
  pausedAnalysis.resume()

  await upgraded

  t.is(
    clientSocket.rawStream.remotePort,
    serverSocket.rawStream.localPort,
    'client switches to the server address'
  )
  t.is(
    serverSocket.rawStream.remotePort,
    clientSocket.rawStream.localPort,
    'server switches to the client address'
  )

  await endAndCloseSocket(clientSocket)
  if (!serverSocket.destroyed) await once(serverSocket, 'close')
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
  let unpause = null
  const punchingResumed = new Promise((resolve) => {
    unpause = resolve
  })

  let restored = false
  const resume = () => {
    if (restored) return
    restored = true
    unpause()
    Holepuncher.prototype._punch = punch
  }

  Holepuncher.prototype._punch = async function () {
    if (pausedNodes.includes(this.dht)) await punchingResumed
    return punch.call(this)
  }

  t.teardown(resume, { force: true })

  return resume
}

function pauseAnalysis(t, node, { remoteHolepunching, bypassAnalysis = false } = {}) {
  const analyze = Holepuncher.prototype.analyze

  let resolveActive
  const active = new Promise((resolve) => {
    resolveActive = resolve
  })

  let unpause
  const resumed = new Promise((resolve) => {
    unpause = resolve
  })

  let restored = false
  const resume = () => {
    if (restored) return
    restored = true
    unpause()
    Holepuncher.prototype.analyze = analyze
  }

  Holepuncher.prototype.analyze = async function (...args) {
    if (
      this.dht === node &&
      (remoteHolepunching === undefined || this.remoteHolepunching === remoteHolepunching)
    ) {
      resolveActive(this)
      await resumed
      if (bypassAnalysis) return true // Keep NAT classification out of the server lifecycle race.
    }

    return analyze.call(this, ...args)
  }

  t.teardown(resume, { force: true })

  return { active, resume }
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

async function createRelayFixture(t, { acceptClient = true } = {}) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap, firewalled: false, ephemeral: true })
  const serverNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  t.teardown(() => Promise.all([relayNode.destroy(), serverNode.destroy(), clientNode.destroy()]))

  await Promise.all([
    relayNode.fullyBootstrapped(),
    serverNode.fullyBootstrapped(),
    clientNode.fullyBootstrapped()
  ])

  const relay = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relay.close())

  const relayServer = relayNode.createServer(function (socket) {
    socket.on('error', () => {})
    // Leaving the client unaccepted holds the server-side pair pending.
    if (!acceptClient && b4a.equals(socket.remotePublicKey, clientNode.defaultKeyPair.publicKey))
      return
    relay.accept(socket, { id: socket.remotePublicKey }).on('error', () => {})
  })

  await relayServer.listen()

  return { serverNode, clientNode, relayServer }
}

async function createParkedRelayFixture(t, { acceptClient = true, relayRecoveryWait = 100 } = {}) {
  const { serverNode, clientNode, relayServer } = await createRelayFixture(t, { acceptClient })
  const Nat = require('../lib/nat')
  const { FIREWALL } = require('../lib/constants')

  // The client classifies as behind a randomizing NAT (like CGNAT), so the
  // server rate limits the punch. Scoped to the client node only.
  Object.defineProperty(Nat.prototype, 'firewall', {
    configurable: true,
    get() {
      return this.dht === clientNode ? FIREWALL.RANDOM : this._testFirewall
    },
    set(value) {
      this._testFirewall = value
    }
  })
  t.teardown(
    () => {
      delete Nat.prototype.firewall
    },
    { force: true }
  )

  // Saturate the random-punch budget so the punch is postponed with TRY_LATER
  serverNode._randomPunches = serverNode._randomPunchLimit

  let resolveTryLater
  const tryLater = new Promise((resolve) => {
    resolveTryLater = resolve
  })

  const server = serverNode.createServer(
    {
      shareLocalAddress: false,
      handshakeClearWait: 100,
      relayRecoveryWait,
      holepunch(remoteFirewall, localFirewall) {
        if (
          (remoteFirewall >= FIREWALL.RANDOM || localFirewall >= FIREWALL.RANDOM) &&
          serverNode._randomPunches >= serverNode._randomPunchLimit
        ) {
          resolveTryLater()
        }
        return true
      }
    },
    function (socket) {
      socket.on('error', () => {})
    }
  )

  await server.listen()

  const connection = once(server, 'connection')
  const socket = clientNode.connect(server.publicKey, {
    relayThrough: relayServer.publicKey,
    localConnection: false,
    fastOpen: false // a randomizing NAT would eat the fast-open packets
  })
  socket.on('error', () => {})
  t.teardown(() => socket.destroy())

  return { serverNode, server, socket, connection, tryLater }
}

test('relayed TRY_LATER stream close destroys the parked server puncher', async function (t) {
  t.timeout(5000)
  const { serverNode, server, socket, connection, tryLater } = await createParkedRelayFixture(t)

  await Promise.all([connection, tryLater])

  const hs = server._holepunches.find((h) => {
    const p = h && h.puncher
    return (
      p &&
      h.relayPaired &&
      h.prepunching === null &&
      p.remoteHolepunching &&
      !p.destroyed &&
      !p.punching &&
      !p.connected
    )
  })
  if (!hs) throw new Error('Missing parked handshake')

  const puncher = hs.puncher
  const punchSocket = puncher.socket
  const rawStreamClosed = once(hs.rawStream, 'close')
  const punchSocketClosed = once(punchSocket, 'close')

  // Normal closure must clean up without relying on the raw-stream error path.
  hs.rawStream.destroy()
  await Promise.all([rawStreamClosed, punchSocketClosed])

  t.ok(puncher.destroyed, 'server destroyed the parked puncher')
  t.absent(serverNode._socketPool.lookup(punchSocket), 'server released the parked punch socket')

  socket.destroy()
})

test('paired relay loss eventually clears a parked TRY_LATER handshake', async function (t) {
  t.timeout(5000)
  const { server, socket, connection, tryLater } = await createParkedRelayFixture(t, {
    relayRecoveryWait: 200
  })
  const socketClosed = closed(socket)

  await Promise.all([connection, tryLater])

  const hs = server._holepunches.find((h) => {
    const p = h && h.puncher
    return (
      p &&
      h.relayPaired &&
      h.prepunching === null &&
      p.remoteHolepunching &&
      !p.destroyed &&
      !p.punching &&
      !p.connected
    )
  })
  if (!hs) throw new Error('Missing parked handshake')

  const relaySocketClosed = closed(hs.relaySocket)
  const rawStream = hs.rawStream
  const punchSocket = hs.puncher.socket
  const rawStreamClosed = closed(rawStream)
  const punchSocketClosed = closed(punchSocket)
  const cleared = handshakeCleared(server, hs)

  hs.relaySocket.destroy()
  await relaySocketClosed

  t.ok(!rawStream.destroyed, 'server keeps the parked handshake during the recovery grace')

  await Promise.all([rawStreamClosed, punchSocketClosed])

  await cleared
  t.absent(
    server._holepunches.find((h) => h === hs),
    'server cleared the parked handshake'
  )

  socket.destroy()
  await socketClosed
})

test('relay transport failure while pairing clears a parked handshake', async function (t) {
  t.timeout(5000)
  const { serverNode, server, socket, tryLater } = await createParkedRelayFixture(t, {
    acceptClient: false
  })

  // The hook fires before the TRY_LATER reply, with relay pairing still pending.
  await tryLater

  const hs = server._holepunches.find((h) => {
    if (!h || !h.puncher) return false
    const p = h.puncher
    return (
      !h.relayPaired &&
      !h.aborted &&
      h.prepunching === null &&
      h.relaySocket &&
      !h.relaySocket.destroyed &&
      h.rawStream &&
      !h.rawStream.destroyed &&
      p.remoteHolepunching &&
      !p.destroyed &&
      !p.punching &&
      !p.connected
    )
  })
  t.ok(hs, 'server parked a live puncher while relay pairing was pending')
  if (!hs) return

  // Check server cleanup before client shutdown can mask a leak.
  const relayAborts = serverNode.stats.relaying.aborts
  const relaySocket = hs.relaySocket
  const relayClient = hs.relayClient
  const rawStream = hs.rawStream
  const punchSocket = hs.puncher.socket
  const relaySocketClosed = closed(relaySocket)
  const relayClientClosed = closed(relayClient)
  const rawStreamClosed = closed(rawStream)
  const punchSocketClosed = closed(punchSocket)
  const cleared = handshakeCleared(server, hs)

  relaySocket.destroy()
  await Promise.all([relaySocketClosed, relayClientClosed, rawStreamClosed, punchSocketClosed])

  t.is(serverNode.stats.relaying.aborts, relayAborts + 1, 'server records one relay pairing abort')

  await cleared
  t.absent(
    server._holepunches.find((h) => h === hs),
    'server cleared the unpaired handshake'
  )

  socket.destroy()
})

test('relay transport failure after pairing clears an unrecoverable handshake', async function (t) {
  t.timeout(5000)
  const { serverNode, clientNode, relayServer } = await createRelayFixture(t)

  const server = serverNode.createServer(
    {
      relayThrough: relayServer.publicKey,
      shareLocalAddress: false,
      holepunch: false,
      handshakeClearWait: 100,
      relayRecoveryWait: 100
    },
    function (socket) {
      socket.on('error', () => {})
    }
  )
  await server.listen()

  const connection = once(server, 'connection')
  const socket = clientNode.connect(server.publicKey, {
    relayThrough: relayServer.publicKey,
    fastOpen: false,
    localConnection: false
  })
  socket.on('error', () => {})
  t.teardown(() => socket.destroy())

  await connection

  const hs = server._holepunches.find(
    (h) =>
      h &&
      h.relayPaired &&
      !h.aborted &&
      h.relaySocket &&
      h.relayClient &&
      h.rawStream &&
      !h.rawStream.destroyed
  )
  t.ok(hs, 'server established the relayed handshake')
  if (!hs) return

  t.absent(hs.puncher, 'the handshake has no direct-punch recovery path')

  const relayAborts = serverNode.stats.relaying.aborts
  const relaySocket = hs.relaySocket
  const relayClient = hs.relayClient
  const rawStream = hs.rawStream
  const relaySocketClosed = closed(relaySocket)
  const relayClientClosed = closed(relayClient)
  const rawStreamClosed = closed(rawStream)
  const cleared = handshakeCleared(server, hs)

  relayClient.destroy(new Error('simulated relay failure'))
  await Promise.all([relaySocketClosed, relayClientClosed, rawStreamClosed])

  await cleared
  t.absent(
    server._holepunches.find((h) => h === hs),
    'server cleared the paired handshake'
  )
  t.is(serverNode.stats.relaying.aborts, relayAborts, 'paired relay loss is not a pairing abort')

  socket.destroy()
})

test('non-punching probes do not extend the relay recovery deadline', async function (t) {
  const Server = require('../lib/server')
  const { ERROR, FIREWALL } = require('../lib/constants')
  const server = new Server(null, { relayRecoveryWait: 30000 })

  const hs = {
    round: 0,
    prepunching: null,
    activeHolepunchRequests: 0,
    relayFailedAt: 1000,
    relayRecoveryTimeout: null,
    rawStream: {
      destroyed: false,
      destroy() {
        this.destroyed = true
      }
    },
    puncher: {
      socket: {},
      remoteHolepunching: false,
      punching: false,
      nat: { firewall: FIREWALL.CONSISTENT, freeze() {} },
      updateRemote() {},
      async analyze() {
        return true
      }
    },
    payload: {
      decrypt: (payload) => payload,
      encrypt: (payload) => payload,
      token: () => null
    }
  }

  server._holepunches.push(hs)
  server._announcer = { isRelay: () => false }

  const peerAddress = { host: '127.0.0.1', port: 12345 }
  const probe = {
    id: 0,
    peerAddress,
    payload: { error: ERROR.NONE, firewall: FIREWALL.CONSISTENT, round: 0, punching: false }
  }
  const req = { from: peerAddress, socket: null }
  const failedAt = hs.relayFailedAt
  const dateNow = Date.now
  let now = failedAt

  t.teardown(
    () => {
      Date.now = dateNow
      clearTimeout(hs.relayRecoveryTimeout)
    },
    { force: true }
  )
  Date.now = () => now

  for (const elapsed of [10000, 20000]) {
    now = failedAt + elapsed
    await server._onpeerholepunch(probe, req)
  }
  t.absent(hs.rawStream.destroyed, 'probes keep the stream alive within the original grace')

  now = failedAt + server.relayRecoveryWait
  await server._onpeerholepunch(probe, req)
  t.ok(hs.rawStream.destroyed, 'request completion cleans up at the original deadline')
})
