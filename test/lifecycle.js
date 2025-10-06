const test = require('brittle')
const safetyCatch = require('safety-catch')
const hypCrypto = require('hypercore-crypto')
const { swarm } = require('./helpers')

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
