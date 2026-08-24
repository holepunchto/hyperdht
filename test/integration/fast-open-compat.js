const test = require('brittle')
const HyperDHT = require('../..')
const HyperDHT6331 = require('hyperdht-6-33-1')
const { swarm } = require('../helpers')

test('fast-open compatibility - 6.33.1 initiator and current responder', async function (t) {
  await compatible(t, HyperDHT6331, HyperDHT, false)
})

test('fast-open compatibility - current initiator and 6.33.1 responder', async function (t) {
  await compatible(t, HyperDHT, HyperDHT6331, true)
})

async function compatible(t, Initiator, Responder, coordinated) {
  const { bootstrap } = await swarm(t, 5)
  const responder = new Responder({ bootstrap, quickFirewall: false, ephemeral: true })
  const initiator = new Initiator({
    bootstrap,
    host: '127.0.0.1',
    quickFirewall: false,
    ephemeral: true
  })

  t.teardown(() => Promise.allSettled([responder.destroy(), initiator.destroy()]))

  let coordinatedPunching = false
  const server = responder.createServer({ shareLocalAddress: false }, function (socket) {
    socket.on('data', function (data) {
      socket.end(data)
    })
  })

  await server.listen()

  const socket = initiator.connect(server.publicKey, {
    localConnection: false,
    holepunch() {
      coordinatedPunching = true
      return true
    }
  })

  socket.end('ping')

  const data = await new Promise((resolve, reject) => {
    socket.once('data', resolve)
    socket.once('error', reject)
  })

  t.alike(data, Buffer.from('ping'))
  t.is(coordinatedPunching, coordinated)
}
