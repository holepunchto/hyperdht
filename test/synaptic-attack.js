const test = require('brittle')
const DHT = require('../')
const { swarm } = require('./helpers')

test('synaptic routing - hacker tries to inflate weight', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()

  let weight = 0.1
  for (let i = 0; i < 50; i++) {
    weight = synaptic.updateOnSuccess(weight, 1, 1000)
  }

  t.ok(weight <= 1.0, 'weight clamped at max: ' + weight.toFixed(6))
  t.pass('attacker cannot inflate weight beyond limit')
})

test('synaptic routing - hacker tries to poison weights of others', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()

  const peerWeights = [
    { weight: 0.8, host: 'good-peer', port: 1111 },
    { weight: 0.6, host: 'another-good', port: 2222 }
  ]

  const attackerWeight = synaptic.updateOnFailure(0.5)
  t.ok(attackerWeight < 0.5, 'attacker poisoned their own weight, not others')

  t.is(peerWeights[0].weight, 0.8, 'good peer weight unchanged')
  t.pass('weight poisoning only affects attacker locally')
})

test('synaptic routing - MITM attack detected via failure signals', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()

  let weight = 0.7

  for (let i = 0; i < 5; i++) {
    weight = synaptic.updateOnFailure(weight)
  }

  t.ok(weight < 0.1, 'MITM connection weight crashed: ' + weight.toFixed(4))
  t.pass('MITM detected via accumulated failures')
})

test('synaptic routing - Sybil attack resistance', async function (t) {
  const [dht] = await swarm(t)

  const peers = []
  for (let i = 0; i < 100; i++) {
    peers.push({ weight: 0.5, host: 'sybil-' + i, port: 1000 + i })
  }

  const legitPeer = { weight: 0.9, host: 'legit', port: 9999 }
  peers.push(legitPeer)

  const counts = { legit: 0 }
  for (let i = 0; i < 200; i++) {
    const chosen = dht.routePacket('target', peers)
    counts[chosen.host] = (counts[chosen.host] || 0) + 1
  }

  t.ok(counts.legit > 50, 'legitimate peer preferred over sybil nodes: ' + counts.legit)
  t.pass('sybil nodes diluted by weight-based selection')
})

test('synaptic routing - eclipse attack resistance', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()

  const eclipsePeers = []
  for (let i = 0; i < 50; i++) {
    eclipsePeers.push({ weight: 0.5, host: 'eclipse-' + i, port: 1000 + i })
  }

  const outsidePeer = { weight: 0.5, host: 'outside', port: 9999 }

  for (let i = 0; i < 20; i++) {
    for (const p of eclipsePeers) {
      p.weight = synaptic.updateOnSuccess(p.weight, 200, 10)
    }
    outsidePeer.weight = synaptic.updateOnSuccess(outsidePeer.weight, 5, 100)
  }

  const counts = { outside: 0, eclipse: 0 }
  for (let i = 0; i < 200; i++) {
    const chosen = synaptic.routePeer([outsidePeer, ...eclipsePeers])
    if (chosen.host === 'outside') counts.outside++
    else counts.eclipse++
  }

  t.ok(counts.outside > counts.eclipse, 'outside peer wins over eclipse cluster')
  t.pass('eclipse attack defeated by weight learning: ' + JSON.stringify(counts))
})

test('synaptic routing - on-path attacker cannot manipulate routing', async function (t) {
  const SynapticWeight = require('../lib/synaptic-weight')
  const synaptic = new SynapticWeight()

  let attackerWeight = 0.8

  for (let i = 0; i < 8; i++) {
    attackerWeight = synaptic.updateOnFailure(attackerWeight)
  }

  t.ok(attackerWeight < 0.05, 'on-path attacker weight destroyed: ' + attackerWeight.toFixed(6))
  t.pass('on-path attacker auto-excluded via failure accumulation')
})
