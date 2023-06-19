const test = require('brittle')
const { toArray, freePort } = require('./helpers')
const DHT = require('../')

test('single node network is enough to find peers', async function (t) {
  const port = await freePort()

  const bootstrap1 = DHT.bootstrapper(port, '127.0.0.1')
  t.ok(await makeServerAndClient([{ host: '127.0.0.1', port }]))
  await bootstrap1.destroy()
})

test('bootstrapper at localhost but bind to all networks (IPv6)', async function (t) {
  const port = await freePort()

  const bootstrap1 = DHT.bootstrapper(port, '127.0.0.1') // NAT host / peer.id is given
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, '0.0.0.0') // It still binds to all networks

  t.ok(await makeServerAndClient([{ host: '127.0.0.1', port }]))

  await bootstrap1.destroy()
})

test('bootstrapper at localhost but bind to all networks (IPv4)', async function (t) {
  const port = await freePort()

  const bootstrap1 = DHT.bootstrapper(port, '127.0.0.1', { host: '0.0.0.0' })
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, '0.0.0.0')

  t.ok(await makeServerAndClient([{ host: '127.0.0.1', port }]))

  await bootstrap1.destroy()
})

test('bootstrapper at localhost and also bind to localhost', async function (t) {
  const port = await freePort()

  const bootstrap1 = DHT.bootstrapper(port, '127.0.0.1', { host: '127.0.0.1' })
  await bootstrap1.ready()
  t.is(bootstrap1.address().host, '127.0.0.1')

  t.ok(await makeServerAndClient([{ host: '127.0.0.1', port }]))

  await bootstrap1.destroy()
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
