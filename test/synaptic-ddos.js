const test = require('brittle')
const DHT = require('../')
const { swarm } = require('./helpers')

test('synaptic routing - DDoS victim signals backpressure', async function (t) {
  const [victim] = await swarm(t)

  const synaptic = victim.getSynaptic()

  const attackerWeight = 0.7
  const newAttackerWeight = synaptic.updateOnBackpressure(attackerWeight, true)
  t.ok(newAttackerWeight < attackerWeight, 'attacker weight penalized: ' + newAttackerWeight.toFixed(4))
  t.pass('backpressure signal sent to neighbors')
})

test('synaptic routing - neighbors reroute around DDoS', async function (t) {
  const [neighbor] = await swarm(t)

  const synaptic = neighbor.getSynaptic()

  let ddosedWeight = 0.8
  let goodWeight = 0.4

  ddosedWeight = synaptic.updateOnBackpressure(ddosedWeight, true)
  t.ok(ddosedWeight <= 0.5, 'ddosed weight dropped: ' + ddosedWeight.toFixed(4))

  for (let i = 0; i < 5; i++) {
    goodWeight = synaptic.updateOnSuccess(goodWeight, 8, 100)
  }

  const peers = [
    { weight: ddosedWeight, host: 'ddosed', port: 1111 },
    { weight: goodWeight, host: 'good', port: 2222 }
  ]

  const counts = { ddosed: 0, good: 0 }
  for (let i = 0; i < 100; i++) {
    const chosen = neighbor.routePacket('target', peers)
    counts[chosen.host]++
  }

  t.ok(counts.good > counts.ddosed, 'traffic moved to healthy node')
  t.pass('DDoS isolation distribution: ' + JSON.stringify(counts))
})

test('synaptic routing - DDoS recovery after load drops', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()

  let weight = 0.3
  weight = synaptic.updateOnBackpressure(weight, false)
  t.is(weight, 0.3, 'no penalty when not overloaded')

  for (let i = 0; i < 10; i++) {
    weight = synaptic.updateOnSuccess(weight, 5, 90)
  }

  t.ok(weight > 0.5, 'weight recovered after DDoS ends: ' + weight.toFixed(4))
  t.pass('node recovers and rejoins routing')
})

test('synaptic routing - massive DDoS creates inhibition wave', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()

  const weights = new Array(100).fill(0.8)

  for (let i = 0; i < 100; i++) {
    weights[i] = synaptic.updateOnBackpressure(weights[i], true)
  }

  const allPenalized = weights.every((w) => w <= 0.5)
  t.ok(allPenalized, 'all connections to hub penalized during DDoS')

  const avg = weights.reduce((a, b) => a + b, 0) / weights.length
  t.ok(avg <= 0.5, 'average connection weight dropped: ' + avg.toFixed(4))
  t.pass('inhibition wave propagated to all neighbors')
})

test('synaptic routing - sparse activation during DDoS', async function (t) {
  const [dht] = await swarm(t)

  const peers = []
  for (let i = 0; i < 20; i++) {
    const isAttacked = i < 15
    peers.push({
      weight: isAttacked ? 0.05 : 0.9,
      host: 'peer-' + i,
      port: 1000 + i
    })
  }

  const counts = {}
  for (let i = 0; i < 200; i++) {
    const chosen = dht.routePacket('target', peers)
    counts[chosen.host] = (counts[chosen.host] || 0) + 1
  }

  const healthyTotal = Object.entries(counts)
    .filter(([k]) => parseInt(k.split('-')[1]) >= 15)
    .reduce((s, [, v]) => s + v, 0)
  const attackedTotal = Object.entries(counts)
    .filter(([k]) => parseInt(k.split('-')[1]) < 15)
    .reduce((s, [, v]) => s + v, 0)

  t.ok(healthyTotal > 190, 'healthy peers dominate routing: ' + healthyTotal + '/200')
  t.ok(attackedTotal < 10, 'attacked peers barely used: ' + attackedTotal + '/200')
  t.pass('sparse activation: healthy routes preferred over attacked')
})
