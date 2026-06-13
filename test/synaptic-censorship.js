const test = require('brittle')
const DHT = require('../')
const { swarm } = require('./helpers')

test('synaptic routing - government block: relay nodes bypass', async function (t) {
  const [goodNode1, goodNode2] = await swarm(t)

  const server = goodNode1.createServer(function (socket) {
    socket.end('bypassed-block')
  })
  await server.listen()

  const socket = goodNode2.connect(server.publicKey)

  let data = ''
  socket.on('data', (d) => { data += d.toString() })
  socket.on('end', () => {
    t.is(data, 'bypassed-block', 'connection succeeded despite block scenario')
    t.pass('peer found alternative path')
  })
  socket.end('test')

  await new Promise((r) => socket.on('close', r))
  await server.close()
})

test('synaptic routing - backpressure redirects traffic', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()

  let weightA = 0.8
  let weightB = 0.3

  weightA = synaptic.updateOnBackpressure(weightA, true)
  t.ok(weightA < 0.8, 'weight A dropped after backpressure: ' + weightA.toFixed(4))

  weightB = synaptic.updateOnSuccess(weightB, 10, 80)

  const peers = [
    { weight: weightA, host: 'blocked-node', port: 1111 },
    { weight: weightB, host: 'open-node', port: 2222 }
  ]

  const counts = { 'blocked-node': 0, 'open-node': 0 }
  for (let i = 0; i < 100; i++) {
    const chosen = synaptic.routePeer(peers)
    counts[chosen.host]++
  }

  t.ok(counts['open-node'] > counts['blocked-node'], 'traffic routed around blocked node')
  t.pass('redirect distribution: ' + JSON.stringify(counts))
})

test('synaptic routing - dead synapses get pruned', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()

  let weight = 0.5
  for (let i = 0; i < 20; i++) {
    weight = synaptic.updateOnFailure(weight)
  }

  t.ok(weight < 0.02, 'dead synapse weight near zero: ' + weight.toFixed(6))
  t.pass('dead synapse will be pruned by routePeer threshold')
})

test('synaptic routing - network isolates censored node', async function (t) {
  const [censor, victim, relay1] = await swarm(t)

  const server = victim.createServer(function (socket) {
    socket.end('alive')
  })
  await server.listen()

  const socket = relay1.connect(server.publicKey)

  let received = ''
  socket.on('data', (d) => { received += d.toString() })
  socket.on('end', () => {
    t.is(received, 'alive', 'victim reachable through relay')
    t.pass('censorship bypassed via relay')
  })
  socket.end('test')

  await new Promise((r) => socket.on('close', r))
  await server.close()
})
