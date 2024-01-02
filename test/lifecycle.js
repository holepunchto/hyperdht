const test = require('brittle')
const { swarm } = require('./helpers')
const safetyCatch = require('safety-catch')

test('Can destroy a DHT node while server.listen() is called', async function (t) {
  const [a] = await swarm(t)

  const server = a.createServer()
  const listenProm = server.listen()
  listenProm.catch(safetyCatch)

  await a.destroy()
  t.ok(a.destroyed === true, 'Can destroy DHT node while listen is being called (does not hang forever)')
  t.ok(server.closed === true, 'The server closed')

  await listenProm
  t.pass('The listen function does not error when the DHT closes while it is running')
})
