const test = require('brittle')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const hypCrypto = require('hypercore-crypto')
const { swarm, toArray } = require('./helpers')
const Persistent = require('../lib/persistent')
const DHT = require('../')

test('Can destroy a DHT node while server.listen() is called', async function (t) {
  const [a] = await swarm(t)

  const server = a.createServer()
  const listenProm = server.listen()
  listenProm.catch(safetyCatch)

  await a.destroy()
  t.ok(
    a.destroyed === true,
    'Can destroy DHT node while listen is being called (does not hang forever)'
  )
  t.ok(server.closed === true, 'The server closed')

  await listenProm
  t.pass('The listen function does not error when the DHT closes while it is running')
})

test('Can close a server during the first announce', async function (t) {
  const [a] = await swarm(t)

  const server = a.createServer()
  const listening = server.listen()
  await new Promise((resolve) => setImmediate(resolve))

  const requests = a.stats.requests.total
  await server.close()
  await listening

  t.is(a.stats.requests.total, requests, 'did not announce')
})

test('Can close a server during a background announce', async function (t) {
  const [a, b] = await swarm(t)
  const server = await a.createServer().listen()
  const publicKey = server.publicKey

  const findPeer = a.findPeer
  const announcing = new Promise((resolve) => {
    a.findPeer = function (...args) {
      resolve()
      return findPeer.apply(this, args)
    }
  })

  server.refresh()
  await announcing
  await server.close()

  t.is((await toArray(b.findPeer(publicKey))).length, 0, 'unannounced')
})

test('Can listen with the same keypair while the previous server is closing', async function (t) {
  const testnet = await swarm(t)
  const [a, b] = testnet
  const keyPair = hypCrypto.keyPair()
  const target = DHT.hash(keyPair.publicKey)

  let release = null
  const released = new Promise((resolve) => {
    release = resolve
  })
  let unannouncing = null
  const unannounceStarted = new Promise((resolve) => {
    unannouncing = resolve
  })

  // Hold the old server's unannounce until released
  const s1 = a.createServer()
  await s1.listen(keyPair, {
    async signUnannounce(...args) {
      unannouncing()
      await released
      return Persistent.signUnannounce(...args)
    }
  })

  const closing = s1.close()
  await unannounceStarted

  let announcing = false
  const findPeer = a.findPeer
  a.findPeer = function (...args) {
    if (b4a.equals(args[0], target)) announcing = true
    return findPeer.apply(this, args)
  }

  const s2 = a.createServer((socket) => socket.on('error', safetyCatch))
  const listening = s2.listen(keyPair)
  await new Promise((resolve) => setImmediate(resolve))

  t.absent(announcing, 'waits for the old server to unannounce before announcing')

  release()
  await closing
  await listening

  const relays = s2._announcer.relays.map((r) => r.relayAddress.port)
  const unrouted = relays.filter((port) => {
    const relay = testnet.nodes.find((node) => node.address().port === port)
    return !relay._router.get(target)
  })
  t.ok(relays.length > 0, 'announced')
  t.alike(unrouted, [], 'every relay the new server announced to still routes to it')

  const socket = b.connect(keyPair.publicKey)
  socket.on('error', safetyCatch)
  const opened = await new Promise((resolve) => {
    socket.once('open', () => resolve(true))
    socket.once('close', () => resolve(false))
  })
  t.ok(opened, 'connected to the new server')

  socket.destroy()
  await s2.close()
})

test('Cannot listen on a closed server', async function (t) {
  const [a] = await swarm(t)

  const server = a.createServer()
  await server.listen()
  await server.close()

  await t.exception(async () => await server.listen(), /SERVER_CLOSED/)
  t.is(server.listening, false, 'not listening')
  t.is(a.listening.has(server), false, 'not tracked by the dht')
})

test('Cannot listen on multiple servers with the same keypair', async function (t) {
  const [a] = await swarm(t)

  const s1 = a.createServer()
  const s2 = a.createServer()

  const s3 = a.createServer()
  const s4 = a.createServer()
  const s5 = a.createServer()

  await s1.listen()
  await t.exception(async () => await s2.listen(), /KEYPAIR_ALREADY_USED/)

  const keyPair = hypCrypto.keyPair()

  await s3.listen(keyPair)
  await t.exception(async () => await s4.listen(keyPair), /KEYPAIR_ALREADY_USED/)
  await s5.listen(hypCrypto.keyPair())
})
