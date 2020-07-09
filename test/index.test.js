'use strict'
const Stream = require('stream')
const { randomBytes } = require('crypto')
const { test } = require('tap')
const { once, promisifyMethod, when } = require('nonsynchronous')
const getPort = require('get-port')
const dht = require('../')
const { dhtBootstrap } = require('./util')

test('default ephemerality', async ({ is }) => {
  const node = dht()
  is(node.ephemeral, false)
  node.destroy()
})

test('destroyed property', async ({ is }) => {
  const node = dht()
  node.listen()
  is(node.destroyed, false)
  node.destroy()
  is(node.destroyed, true)
})

test('ephemeral option', async ({ is }) => {
  const node = dht({
    ephemeral: false
  })
  is(node.ephemeral, false)
  node.destroy()
})

test('bootstrap option', async ({ is }) => {
  const { bootstrap, closeDht, port } = await dhtBootstrap()
  const node = dht({ bootstrap })
  promisifyMethod(node, 'listen')
  await node.listen()
  is(node.bootstrapNodes.length, 1)
  is(node.bootstrapNodes[0].port, port)
  node.destroy()
  closeDht()
})

test('adaptive option validation', async ({ throws, doesNotThrow }) => {
  throws(() => {
    dht({
      ephemeral: false,
      adaptive: true
    })
  }, Error('adaptive mode can only applied when ephemeral: true'))
  throws(() => {
    dht({ adaptive: true })
  }, Error('adaptive mode can only applied when ephemeral: true'))
  doesNotThrow(() => {
    const node = dht({ adaptive: true, ephemeral: true })
    node.destroy()
  })
})

test('emits listening event when bound', async ({ pass }) => {
  const node = dht()
  node.listen()
  await once(node, 'listening')
  pass('event emitted')
  node.destroy()
})

test('emits close event when destroyed', async ({ pass }) => {
  const node = dht()
  promisifyMethod(node, 'listen')
  await node.listen()
  node.destroy()
  await once(node, 'close')
  pass('event emitted')
})

test('announce & lookup', async ({ is }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer, 'lookup')
  const port = await getPort()
  await peer.announce(topic, { port })
  const [{ node, peers, localPeers }] = await peer.lookup(topic)
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  peer.destroy()
  closeDht()
})

test('announce & lookup stream', async ({ is }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  const port = await getPort()
  await peer.announce(topic, { port })
  const stream = peer.lookup(topic)
  const [{ node, peers, localPeers }] = await once(stream, 'data')
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  peer.destroy()
  closeDht()
})

test('announce & lookup port', async ({ is, fail }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap({ ephemeral: false })
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  const port = await getPort()
  const port2 = await getPort()
  await peer.announce(topic, { port })
  await peer2.announce(topic, { port2 })
  const stream = peer2.lookup(topic, { port: port2 })
  const [{ node, peers, localPeers }] = await once(stream, 'data')
  stream.on('data', () => fail('should be no more data'))
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('lookup event', async ({ is, fail }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: false
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: false
  })
  const lookupEvent = once(peer, 'lookup')
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  const port = await getPort()
  const port2 = await getPort()
  await peer.announce(topic, { port })
  await peer2.announce(topic, { port2 })

  const stream = peer2.lookup(topic, { port: port2 })
  const [{ node, peers, localPeers }] = await once(stream, 'data')
  await lookupEvent
  stream.on('data', () => fail('should be no more data'))
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('announce own port', async ({ is }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer2, 'lookup')
  await peer.announce(topic)
  const [{ node, peers, localPeers }] = await peer2.lookup(topic)
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('unannounce', async ({ is }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer, 'unannounce')
  promisifyMethod(peer, 'lookup')
  const port = await getPort()
  await peer.announce(topic, { port })
  const [{ node, peers, localPeers }] = await peer.lookup(topic)
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  await peer.unannounce(topic, { port })
  const result = await peer.lookup(topic)
  is(result.length, 0)
  peer.destroy()
  closeDht()
})

test('unannounce own port', async ({ is }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer, 'unannounce')
  promisifyMethod(peer2, 'lookup')
  await peer.announce(topic)
  const [{ node, peers, localPeers }] = await peer2.lookup(topic)
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  await peer.unannounce(topic)
  const result = await peer2.lookup(topic)
  is(result.length, 0)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('announce event', async ({ is }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  peer.name = 'peer'
  const peer2 = dht({
    bootstrap,
    ephemeral: false
  })
  peer2.name = 'peer2'
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer, 'unannounce')
  promisifyMethod(peer2, 'lookup')
  peer.announce(topic)
  await once(peer2, 'announce')
  const [{ node, peers, localPeers }] = await peer2.lookup(topic)
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  await peer.unannounce(topic)
  const result = await peer2.lookup(topic)
  is(result.length, 0)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('unannounce event', async ({ is }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  peer.name = 'peer'
  const peer2 = dht({
    bootstrap,
    ephemeral: false
  })
  peer2.name = 'peer2'
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer, 'unannounce')
  promisifyMethod(peer2, 'lookup')
  await peer.announce(topic)
  const [{ node, peers, localPeers }] = await peer2.lookup(topic)
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  peer.unannounce(topic)
  await once(peer2, 'unannounce')
  const result = await peer2.lookup(topic)
  is(result.length, 0)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('announce bad port', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer, 'lookup')
  try {
    await peer.announce(topic, { port: 65536 })
  } catch (err) {
    is(err.message, 'No close nodes responded')
  }
  peer.destroy()
  closeDht()
})

test('announce & lookup localAddress', async ({ is, fail }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer2, 'lookup')
  await peer.announce(topic, {
    localAddress: {
      host: '192.168.100.100',
      port: 20000
    }
  })
  const [{ node, peers, localPeers }] = await peer2.lookup(topic, {
    localAddress: {
      host: '192.168.100.101',
      port: 20000
    }
  })
  const [localPeer] = localPeers
  is(localPeer.host, '192.168.100.100')
  is(localPeer.port, 20000)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  const result = await peer2.lookup(topic, {
    localAddress: {
      host: '192.169.100.100',
      port: 20000
    }
  })
  is(result[0].localPeers, null)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('unnanounce localAddress', async ({ is, fail }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer, 'unannounce')
  promisifyMethod(peer2, 'lookup')
  await peer.announce(topic, {
    localAddress: {
      host: '192.168.100.100',
      port: 20000
    }
  })
  const [{ node, peers, localPeers }] = await peer2.lookup(topic, {
    localAddress: {
      host: '192.168.100.101',
      port: 20000
    }
  })
  const [localPeer] = localPeers
  is(localPeer.host, '192.168.100.100')
  is(localPeer.port, 20000)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  await peer.unannounce(topic, {
    localAddress: {
      host: '192.168.100.100',
      port: 20000
    }
  })
  const result = await peer2.lookup(topic, {
    localAddress: {
      host: '192.168.100.101',
      port: 20000
    }
  })
  is(result.length, 0)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('unnanounce localAddress on same peer', async ({ is, fail }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer, 'unannounce')
  promisifyMethod(peer2, 'lookup')
  await peer.announce(topic, {
    localAddress: {
      host: '192.168.100.100',
      port: 20000
    }
  })
  const [{ node, peers, localPeers }] = await peer2.lookup(topic, {
    localAddress: {
      host: '192.168.100.101',
      port: 20000
    }
  })
  const [localPeer] = localPeers
  is(localPeer.host, '192.168.100.100')
  is(localPeer.port, 20000)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  await peer.unannounce(topic, {
    localAddress: {
      host: '192.168.100.100',
      port: 20000
    }
  })
  const result = await peer2.lookup(topic, {
    localAddress: {
      host: '192.168.100.101',
      port: 20000
    }
  })
  is(result.length, 0)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('double announce', async ({ is }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  promisifyMethod(peer2, 'lookup')
  await peer.announce(topic)
  await peer.announce(topic)
  const [{ node, peers, localPeers }] = await peer2.lookup(topic)
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('corrupt localAddress data (wrong buffer length)', async ({ is, fail }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  await peer.announce(topic, {
    localAddress: {
      host: '192.168.100.100',
      port: 20000
    }
  })
  const stream = peer2.lookup(topic, {
    localAddress: {
      host: '192.168.100.101',
      port: 20000
    }
  })
  // simulate a peer responding with bad data
  const { _map } = stream
  stream._map = (data) => {
    data.value.localPeers = data.value.localPeers.slice(1)
    return _map(data)
  }
  const [{ node, peers, localPeers }] = await once(stream, 'data')
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('corrupt localAddress data (nil port)', async ({ is, fail }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const { port } = peer.address()
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  await peer.announce(topic, {
    localAddress: {
      host: '192.168.100.100',
      port: 20000
    }
  })
  const stream = peer2.lookup(topic, {
    localAddress: {
      host: '192.168.100.101',
      port: 20000
    }
  })
  // simulate a peer responding with bad data
  const { _map } = stream
  stream._map = (data) => {
    data.value.localPeers.fill(0)
    return _map(data)
  }
  const [{ node, peers, localPeers }] = await once(stream, 'data')
  is(localPeers, null)
  is(peers.length, 1)
  is(peers[0].port, port)
  is(node.port, bsPort)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('corrupt peer data (wrong buffer length)', async ({ is, fail }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  await peer.announce(topic, {
    localAddress: {
      host: '192.168.100.100',
      port: 20000
    }
  })
  const stream = peer2.lookup(topic, {
    localAddress: {
      host: '192.168.100.101',
      port: 20000
    }
  })
  // simulate a peer responding with bad data
  const { _map } = stream
  stream._map = (data) => {
    data.value.peers = data.value.peers.slice(1)
    return _map(data)
  }
  const [{ node, peers, localPeers }] = await once(stream, 'data')
  const [localPeer] = localPeers
  is(localPeer.host, '192.168.100.100')
  is(localPeer.port, 20000)
  is(peers, null)
  is(node.port, bsPort)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('corrupt peer data (nill buffer)', async ({ is, fail }) => {
  const { bootstrap, closeDht, port: bsPort } = await dhtBootstrap()
  const peer = dht({
    bootstrap,
    ephemeral: true
  })
  const peer2 = dht({
    bootstrap,
    ephemeral: true
  })
  await once(peer, 'listening')
  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  await peer.announce(topic, {
    localAddress: {
      host: '192.168.100.100',
      port: 20000
    }
  })
  const stream = peer2.lookup(topic, {
    localAddress: {
      host: '192.168.100.101',
      port: 20000
    }
  })
  // simulate a peer responding with bad data
  const { _map } = stream
  stream._map = (data) => {
    data.value.peers.fill(0)
    return _map(data)
  }
  const [{ node, peers, localPeers }] = await once(stream, 'data')
  const [localPeer] = localPeers
  is(localPeer.host, '192.168.100.100')
  is(localPeer.port, 20000)
  is(peers, null)
  is(node.port, bsPort)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('adaptive ephemerality', async ({ is, ok, pass, resolves, rejects, tearDown }) => {
  tearDown(() => {
    peer.destroy()
    adapt.destroy()
    closeDht()
  })
  const { bootstrap, closeDht } = await dhtBootstrap({
    ephemeral: true,
    size: 2
  })

  const adapt = dht({
    ephemeral: true,
    adaptive: true,
    bootstrap
  })
  adapt.name = 'adapt'
  await once(adapt, 'ready')

  const peer = dht({
    ephemeral: true,
    bootstrap
  })

  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  await rejects(
    () => peer.announce(topic, { port: 12345 }),
    Error('No close nodes responded'),
    'expected no nodes found'
  )
  const t = adapt._adaptiveTimeout.timeout
  ok(t._idleTimeout >= 1.2e+6) // >= 20 mins
  ok(t._idleTimeout <= 1.8e+6) // <= 30 mins
  const { persistent } = adapt
  let persistentCalled = false
  adapt.persistent = (cb) => {
    persistentCalled = true
    return persistent.call(adapt, cb)
  }
  is(adapt.ephemeral, true)
  const dhtJoined = once(adapt, 'persistent')
  resolves(dhtJoined, 'dht joined event fired')
  is(persistentCalled, false)
  // fake holepunchable
  adapt.holepunchable = () => true
  // force the timeout to resolve:
  t._onTimeout()
  clearTimeout(t)
  await dhtJoined
  is(persistentCalled, true)
  is(adapt.ephemeral, false)
  promisifyMethod(peer, 'bootstrap')
  await peer.bootstrap() // speed up discovery of now non-ephemeral "adapt" peer
  await peer.announce(topic, { port: 12345 })
  const stream = peer.lookup(topic)
  const [{ node }] = await once(stream, 'data')
  is(Buffer.compare(node.id, adapt.id), 0)
})

test('adaptive ephemerality - emits warning on dht joining error', async ({ is, resolves, rejects, tearDown }) => {
  tearDown(() => {
    peer.destroy()
    adapt.destroy()
    closeDht()
  })
  const { bootstrap, closeDht } = await dhtBootstrap({
    ephemeral: true,
    size: 2
  })

  const adapt = dht({
    ephemeral: true,
    adaptive: true,
    bootstrap
  })
  adapt.name = 'adapt'
  await once(adapt, 'ready')

  const peer = dht({
    ephemeral: true,
    bootstrap
  })

  const topic = randomBytes(32)
  promisifyMethod(peer, 'announce')
  await rejects(
    () => peer.announce(topic, { port: 12345 }),
    Error('No close nodes responded'),
    'expected no nodes found'
  )
  const t = adapt._adaptiveTimeout.timeout
  is(adapt.ephemeral, true)
  const warning = once(adapt, 'warning')
  resolves(warning, 'warning emitted')
  adapt.query = () => {
    const qsMock = new Stream()
    qsMock.on('error', () => {
    })
    process.nextTick(() => {
      qsMock.emit('error', Error('test'))
    })
    return qsMock
  }
  // fake holepunchable
  adapt.holepunchable = () => true
  // force the timeout to resolve:
  t._onTimeout()
  adapt._adaptiveTimeout.close()
  const [err] = await warning
  is(err.message, 'Unable to dynamically become non-ephemeral: test')
  is(adapt.ephemeral, true)
})

test('adaptive ephemerality - timeout clears on destroy', async ({ is, pass, tearDown }) => {
  const { clearTimeout } = global
  const until = when()
  tearDown(() => {
    global.clearTimeout = clearTimeout
    closeDht(0)
  })
  const { bootstrap, closeDht } = await dhtBootstrap({ ephemeral: true })

  const adapt = dht({
    ephemeral: true,
    adaptive: true,
    bootstrap
  })
  await once(adapt, 'ready')
  global.clearTimeout = (t) => {
    if (t === null) return
    pass('timeout cleared')
    until()
    clearTimeout(t)
  }
  adapt.destroy()
  await until.done()
})
