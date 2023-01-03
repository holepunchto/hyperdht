const test = require('brittle')
const { toArray } = require('./helpers')
const DHT = require('../')
const UDX = require('udx-native')

// maybe '0.0.0.0' is just an invalid address for a dht node
// because that just "listens" in all interfaces, so a node has effectively multiple connectable host addresses
// but this dht node can only decide one valid address for the nat of itself, and i.e. other eph nodes will only be able to succesfully talk with that specific nat address

console.log('localIP:', localIP())

test('single node network is enough to find peers', async function (t) {
  const bootstrap1 = DHT.bootstrapper(49737, '127.0.0.1')
  t.ok(await makeServerAndClient([{ host: '127.0.0.1', port: 49737 }]))
  await bootstrap1.destroy()
})

test('bootstrapper at localhost but bind to all networks (IPv6)', async function (t) {
  const bootstrap1 = DHT.bootstrapper(49737, '127.0.0.1') // Nat host is given
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, '::') // It still binds to all networks (if this is a problem, is kind of improvable)

  t.ok(await makeServerAndClient([{ host: '127.0.0.1', port: 49737 }]))
  // t.ok(await makeServerAndClient([{ host: '0.0.0.0', port: 49737 }])) // + why this works? I think it should not work (and btw '::' doesn't)

  // This is fine: it doesn't work because of the added NAT that says '127.0.0.1' (as defined on bootstrapper arg), it's even while binding to '0.0.0.0' or '::' as it is
  t.absent(await makeServerAndClient([{ host: localIP(), port: 49737 }]))

  await bootstrap1.destroy()
})

test('bootstrapper at localhost but bind to all networks (IPv4)', async function (t) {
  const bootstrap1 = DHT.bootstrapper(49737, '127.0.0.1', { host: '0.0.0.0' })
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, '0.0.0.0')

  t.ok(await makeServerAndClient([{ host: '127.0.0.1', port: 49737 }]))
  // t.ok(await makeServerAndClient([{ host: '0.0.0.0', port: 49737 }])) // + maybe here makes sense but still why it works exactly?

  t.absent(await makeServerAndClient([{ host: localIP(), port: 49737 }])) // + local host address

  await bootstrap1.destroy()
})

test('bootstrapper at localhost and also bind to localhost', async function (t) {
  const bootstrap1 = DHT.bootstrapper(49737, '127.0.0.1', { host: '127.0.0.1' })
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, '127.0.0.1')

  t.ok(await makeServerAndClient([{ host: '127.0.0.1', port: 49737 }]))
  // t.ok(await makeServerAndClient([{ host: '0.0.0.0', port: 49737 }])) // + why this still works?

  await bootstrap1.destroy()
})

test('first persistent node with no host given', async function (t) {
  // No host is given, so it assumes the first local host address (eg 192.168.0.23) as a NAT host
  const bootstrap1 = new DHT({ bootstrap: [], ephemeral: false, firewalled: false })
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, '::') // It still binds to all networks

  t.ok(await makeServerAndClient([{ host: localIP(), port: bootstrap1.address().port }]))

  // This is fine: it doesn't work due different peer id and/or NAT host. I mean it's reachable but NAT host address, peer id or something doesn't match
  t.absent(await makeServerAndClient([{ host: '127.0.0.1', port: bootstrap1.address().port }]))

  await bootstrap1.destroy()
})

test.skip('first persistent node but binds to IPv6 localhost', async function (t) {
  // + I think this deosn't due peer.id encoding
  const bootstrap1 = new DHT({ bootstrap: [], ephemeral: false, firewalled: false, host: '::1' })
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, '::1')

  t.ok(await makeServerAndClient([{ host: '::1', port: bootstrap1.address().port }]))

  await bootstrap1.destroy()
})

test('first persistent node but binds to IPv4 localhost', async function (t) {
  const bootstrap1 = new DHT({ bootstrap: [], ephemeral: false, firewalled: false, host: '127.0.0.1' })
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, '127.0.0.1')

  t.ok(await makeServerAndClient([{ host: '127.0.0.1', port: bootstrap1.address().port }]))

  await bootstrap1.destroy()
})

test('first persistent node with no host given but binds to local host address', async function (t) {
  const bootstrap1 = new DHT({ bootstrap: [], ephemeral: false, firewalled: false, host: localIP() })
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, localIP())

  t.ok(await makeServerAndClient([{ host: localIP(), port: bootstrap1.address().port }]))

  await bootstrap1.destroy()
})

test.skip('ephemeral node enters persistent mode, and later goes back to ephemeral', async function (t) {
  // + this should test when a node is adaptive and becomes persistent naturally
  // but then later goes back into 'ephemeral' mode (i.e. due sleep, etc)
  // currently, hyperdht is not destroying the persistent class object when it goes back to eph
})

async function makeServerAndClient (bootstrap) {
  const a = new DHT({ bootstrap, ephemeral: true })
  await a.ready()
  const server = a.createServer()
  await server.listen()

  const b = new DHT({ bootstrap, ephemeral: true })
  await b.ready()
  const result = await toArray(b.findPeer(server.publicKey))

  const success = result.length > 0 && result[0].peer.publicKey.toString() === server.publicKey.toString()

  await b.destroy()
  await a.destroy()

  return success
}

// i.e. 192.168.0.23
function localIP () {
  const udx = new UDX()
  let host = null
  for (const n of udx.networkInterfaces()) {
    if (n.family !== 4 || n.internal) continue
    if (n.name === 'en0') return n.host
    if (host === null) host = n.host
  }
  return host || '127.0.0.1'
}

/* function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sleep (ms) {
  if (!this.nil) this.nil = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(nil, 0, 0, ms)
} */
