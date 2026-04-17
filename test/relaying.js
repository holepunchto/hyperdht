const test = require('brittle')
const { once } = require('events')
const RelayServer = require('blind-relay').Server
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
  const b = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  const lc = t.test('socket lifecycle')
  lc.plan(5)
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
      relayThrough: aServer.publicKey
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

  await c.destroy()
  await b.destroy()
  await a.destroy()
})

test('relay connection upgrades to direct connection', { timeout: 30000 }, async function (t) {
  const { bootstrap } = await swarm(t)

  const relayNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const serverNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const clientNode = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

  // Capture raw-stream transitions so we can prove the socket upgrades in place.
  instrumentRawStreams(t, serverNode)
  instrumentRawStreams(t, clientNode)
  // Bias the race so relay wins first for these nodes only; upgrade assertions below are still condition-based.
  delayPunching(t, 500, [serverNode, clientNode])

  const relayServer = new RelayServer({
    createStream(opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  t.teardown(() => relayServer.close())

  const relayTransportServer = relayNode.createServer(function (socket) {
    const session = relayServer.accept(socket, { id: socket.remotePublicKey })
    session.on('error', (err) => t.comment(err.message))
  })

  await relayTransportServer.listen()

  let serverSocket = null
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
      serverSocket = socket
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

  await once(clientSocket, 'open')
  await serverSocketOpened

  t.is(clientSocket.rawStream._transitions.length, 1, 'client starts on the relayed stream')
  t.is(serverSocket.rawStream._transitions.length, 1, 'server starts on the relayed stream')
  t.is(clientSocket.rawStream._transitions[0].type, 'connect')
  t.is(serverSocket.rawStream._transitions[0].type, 'connect')

  // The relayed connection should already be usable before the direct path wins.
  const beforeUpgrade = once(clientSocket, 'data')
  clientSocket.write(Buffer.from('before upgrade'))
  t.alike((await beforeUpgrade)[0], Buffer.from('before upgrade'), 'relay path carries data')

  // changeRemote is the signal that the same raw stream switched transport.
  await waitForUpgrade(clientSocket.rawStream)
  await waitForUpgrade(serverSocket.rawStream)

  const clientTransitions = clientSocket.rawStream._transitions
  const serverTransitions = serverSocket.rawStream._transitions

  t.is(clientTransitions[1].type, 'changeRemote')
  t.is(serverTransitions[1].type, 'changeRemote')
  t.ok(
    clientTransitions[0].host !== clientTransitions[1].host ||
      clientTransitions[0].port !== clientTransitions[1].port,
    'client switches away from the relay address'
  )
  t.ok(
    serverTransitions[0].host !== serverTransitions[1].host ||
      serverTransitions[0].port !== serverTransitions[1].port,
    'server switches away from the relay address'
  )

  const afterUpgrade = once(clientSocket, 'data')
  clientSocket.write(Buffer.from('after upgrade'))
  t.alike((await afterUpgrade)[0], Buffer.from('after upgrade'), 'direct path carries data')

  await endAndCloseSocket(clientSocket)
  if (!serverSocket.destroyed) await once(serverSocket, 'close')

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

function instrumentRawStreams(t, dht) {
  const createRawStream = dht.createRawStream.bind(dht)

  dht.createRawStream = function (...args) {
    const stream = createRawStream(...args)
    stream._transitions = []

    // Record the initial relay connect and the later direct changeRemote.
    const connect = stream.connect.bind(stream)
    stream.connect = function (socket, id, port, host) {
      stream._transitions.push({ type: 'connect', host, port })
      return connect(socket, id, port, host)
    }

    const changeRemote = stream.changeRemote.bind(stream)
    stream.changeRemote = function (socket, id, port, host) {
      stream._transitions.push({ type: 'changeRemote', host, port })
      return changeRemote(socket, id, port, host)
    }

    return stream
  }

  t.teardown(() => {
    dht.createRawStream = createRawStream
  })
}

function delayPunching(t, ms, delayedNodes) {
  const punch = Holepuncher.prototype._punch

  Holepuncher.prototype._punch = async function () {
    // Only delay the punchers created by this test.
    if (delayedNodes.includes(this.dht)) {
      // Bias the race without changing the real upgrade logic.
      await new Promise((resolve) => setTimeout(resolve, ms))
    }
    return punch.call(this)
  }

  t.teardown(() => {
    Holepuncher.prototype._punch = punch
  })
}

async function waitForUpgrade(stream) {
  const started = Date.now()

  // Poll until the raw stream reports its remote endpoint changed.
  while (!stream._transitions.some((transition) => transition.type === 'changeRemote')) {
    if (Date.now() - started > 5000) {
      throw new Error('Timed out waiting for relay-to-direct upgrade')
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
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
