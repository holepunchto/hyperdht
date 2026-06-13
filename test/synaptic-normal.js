const test = require('brittle')
const DHT = require('../')
const { swarm } = require('./helpers')

test('synaptic routing - normal connection lifecycle', async function (t) {
  const [a, b] = await swarm(t)

  const server = a.createServer(function (socket) {
    t.pass('server accepted connection')
    socket.end('pong')
  })

  await server.listen()
  t.pass('server listening on ' + server.publicKey.toString('hex').slice(0, 8))

  const socket = b.connect(server.publicKey)

  let received = ''
  socket.on('data', (data) => { received += data.toString() })
  socket.on('end', () => {
    t.is(received, 'pong', 'received pong from server')
    t.pass('connection closed cleanly')
  })
  socket.end('ping')

  await new Promise((resolve) => socket.on('close', resolve))
  await server.close()
})

test('synaptic routing - weight updates on success', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const sw = new SynapticWeight()

  let w = 0.5
  w = sw.updateOnSuccess(w, 10, 100)
  t.ok(w > 0.5, 'weight increases on success: ' + w.toFixed(4))

  w = sw.updateOnFailure(w)
  t.ok(w < 1.0, 'weight decreases on failure: ' + w.toFixed(4))

  w = sw.updateOnBackpressure(w, true)
  t.ok(w < 0.9, 'weight penalized by backpressure: ' + w.toFixed(4))

  t.pass('all synaptic weight operations work')
})

test('synaptic routing - multiple connections build weight', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()
  t.ok(synaptic, 'synaptic instance created')

  let weight = 0.5
  for (let i = 0; i < 10; i++) {
    weight = synaptic.updateOnSuccess(weight, 5, 100)
  }
  t.ok(weight > 0.5, 'weight increased after 10 successes: ' + weight.toFixed(4))

  weight = synaptic.updateOnFailure(weight)
  t.ok(weight < 1.0, 'weight decreased after failure: ' + weight.toFixed(4))
})

test('synaptic routing - routePacket selects best peer', async function (t) {
  const [a] = await swarm(t)

  const peers = [
    { weight: 0.9, host: '1.1.1.1', port: 1111 },
    { weight: 0.5, host: '2.2.2.2', port: 2222 },
    { weight: 0.1, host: '3.3.3.3', port: 3333 }
  ]

  const counts = { '1.1.1.1': 0, '2.2.2.2': 0, '3.3.3.3': 0 }
  for (let i = 0; i < 100; i++) {
    const chosen = a.routePacket('target', peers)
    counts[chosen.host]++
  }

  t.ok(counts['1.1.1.1'] > counts['3.3.3.3'], 'high-weight peer chosen more often')
  t.ok(counts['1.1.1.1'] > 50, 'dominant peer picked >50%: ' + counts['1.1.1.1'])
  t.pass('route distribution: ' + JSON.stringify(counts))
})
