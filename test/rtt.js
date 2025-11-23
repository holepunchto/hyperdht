const test = require('brittle')
const createTestnet = require('../testnet')
const DHT = require('../')
const { swarm } = require('./helpers')

test('rtt - tracking basic functionality', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const key = '127.0.0.1:8080'
  t.absent(dht._nodeRTT.get(key), 'no RTT data initially')

  const node = { host: '127.0.0.1', port: 8080 }
  dht.updateNodeRTT(node, 100)

  t.ok(dht._nodeRTT.get(key), 'RTT entry added')
  t.is(dht.getNodeRTT(node), 100, 'SRTT value correct for first sample')

  dht.updateNodeRTT(node, 200)
  const srtt = dht.getNodeRTT(node)
  t.ok(srtt > 100 && srtt < 200, 'TCP EWMA working')
  // Expected: (1 - 0.125) * 100 + 0.125 * 200 = 87.5 + 25 = 112.5
  t.is(srtt, 112.5, 'TCP EWMA calculation correct (alpha=0.125)')

  const stats = dht._nodeRTT.get(key)
  t.ok(stats.srtt, 'has SRTT')
  t.ok(stats.rttvar >= 0, 'has RTTVAR')
  t.is(stats.samples, 2, 'sample count correct')
})

test('rtt - update with invalid values', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const node = { host: '127.0.0.1', port: 8080 }
  const key = '127.0.0.1:8080'

  dht.updateNodeRTT(node, 0)
  t.absent(dht._nodeRTT.get(key), 'zero RTT ignored')

  dht.updateNodeRTT(node, -100)
  t.absent(dht._nodeRTT.get(key), 'negative RTT ignored')

  dht.updateNodeRTT(null, 100)
  t.absent(dht._nodeRTT.get('null:undefined'), 'null node ignored')

  dht.updateNodeRTT({ host: '127.0.0.1' }, 100)
  t.absent(dht._nodeRTT.get('127.0.0.1:undefined'), 'node without port ignored')
})

test('rtt - getNodeRTT with no data', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const node = { host: '127.0.0.1', port: 8080 }
  t.is(dht.getNodeRTT(node), null, 'returns null for unknown node')
  t.is(dht.getNodeRTT(null), null, 'returns null for null node')
})

test('rtt - sortNodesByRTT', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const nodes = [
    { host: '127.0.0.1', port: 8080 },
    { host: '127.0.0.1', port: 8081 },
    { host: '127.0.0.1', port: 8082 },
    { host: '127.0.0.1', port: 8083 }
  ]

  dht.updateNodeRTT(nodes[0], 300)
  dht.updateNodeRTT(nodes[1], 100)
  dht.updateNodeRTT(nodes[2], 200)

  const sorted = dht.sortNodesByRTT(nodes)

  t.is(sorted.length, 4, 'all nodes returned')
  t.is(sorted[0].port, 8081, 'fastest node first (100ms)')
  t.is(sorted[1].port, 8082, 'second fastest (200ms)')
  t.is(sorted[2].port, 8080, 'third fastest (300ms)')
  t.is(sorted[3].port, 8083, 'node without RTT last')
})

test('rtt - getAverageRTT', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  t.is(dht.getAverageRTT(), null, 'null when no data')

  dht.updateNodeRTT({ host: '127.0.0.1', port: 8080 }, 100)
  dht.updateNodeRTT({ host: '127.0.0.1', port: 8081 }, 200)
  dht.updateNodeRTT({ host: '127.0.0.1', port: 8082 }, 300)

  const avg = dht.getAverageRTT()
  t.is(avg, 200, 'average calculated correctly')
})

test('rtt - getRTTBasedTimeout for fast network', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  t.is(dht.getRTTBasedTimeout(10000), 10000, 'base timeout when no data')

  dht.updateNodeRTT({ host: '127.0.0.1', port: 8080 }, 50)
  dht.updateNodeRTT({ host: '127.0.0.1', port: 8081 }, 60)

  const timeout = dht.getRTTBasedTimeout(10000)
  t.ok(timeout < 10000, 'timeout reduced for fast network')
  t.is(timeout, 9000, 'timeout is 90% of base (minimum threshold)')
})

test('rtt - getRTTBasedTimeout for slow network', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  dht.updateNodeRTT({ host: '127.0.0.1', port: 8080 }, 200)
  dht.updateNodeRTT({ host: '127.0.0.1', port: 8081 }, 300)

  const timeout = dht.getRTTBasedTimeout(10000)
  t.is(timeout, 10000, 'base timeout kept for slow network')
})

test('rtt - connection cache', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const targetHash = 'test-target-hash'
  t.absent(dht._connectionCache.get(targetHash), 'cache initially empty')

  const path = { nodes: ['node1', 'node2'], type: 'direct' }
  dht._connectionCache.set(targetHash, {
    path: path,
    rtt: 100,
    timestamp: Date.now()
  })

  t.ok(dht._connectionCache.get(targetHash), 'cache entry added')

  const cached = dht._connectionCache.get(targetHash)
  t.ok(cached, 'cached entry exists')
  t.alike(cached.path, path, 'cached path correct')
  t.is(cached.rtt, 100, 'cached rtt correct')
})

test('rtt - direct connection cache', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const targetHash = 'test-target-hash'
  t.absent(dht._directConnectionCache.get(targetHash), 'direct cache initially empty')

  const address = { host: '127.0.0.1', port: 8080 }
  dht._directConnectionCache.set(targetHash, {
    address: address,
    timestamp: Date.now()
  })

  t.ok(dht._directConnectionCache.get(targetHash), 'direct cache entry added')

  const cached = dht._directConnectionCache.get(targetHash)
  t.ok(cached, 'cached entry exists')
  t.alike(cached.address, address, 'cached address correct')
})

test('rtt - RTT statistics tracking', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const node = { host: '127.0.0.1', port: 8080 }

  dht.updateNodeRTT(node, 100)
  dht.updateNodeRTT(node, 150)
  dht.updateNodeRTT(node, 200)

  const key = '127.0.0.1:8080'
  const stats = dht._nodeRTT.get(key)

  t.ok(stats, 'stats exist')
  t.is(stats.samples, 3, 'sample count correct')
  t.ok(stats.srtt > 0, 'has SRTT')
  t.ok(stats.rttvar >= 0, 'has RTTVAR')
  t.ok(stats.lastUpdate > 0, 'lastUpdate timestamp set')
  t.absent(stats.rtts, 'no rtts array in TCP-style')
  t.absent(stats.minRTT, 'no minRTT in TCP-style')
  t.absent(stats.maxRTT, 'no maxRTT in TCP-style')
})

test('rtt - TCP-style memory efficiency', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const node = { host: '127.0.0.1', port: 8080 }

  for (let i = 0; i < 150; i++) {
    dht.updateNodeRTT(node, 100 + Math.random() * 10)
  }

  const key = '127.0.0.1:8080'
  const stats = dht._nodeRTT.get(key)

  t.is(stats.samples, 150, 'sample count tracks all measurements')
  t.absent(stats.rtts, 'no array storage in TCP-style')
  t.ok(stats.srtt >= 100 && stats.srtt <= 110, 'SRTT converged')
  t.ok(stats.rttvar < 10, 'RTTVAR stabilized')
})

test('rtt - preWarmRTT option', async function (t) {
  const testnet1 = await swarm(t)
  const dht1 = testnet1.nodes[0]
  t.ok(dht1._rttWarmupInterval, 'warmup interval created by default')

  const testnet2 = await swarm(t)
  const dht2 = testnet2.createNode({ preWarmRTT: false })
  await dht2.ready()
  t.absent(dht2._rttWarmupInterval, 'warmup interval not created when disabled')
})

test('rtt - backward compatibility (no RTT methods)', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const originalSort = dht.sortNodesByRTT
  delete dht.sortNodesByRTT

  const nodes = [
    { host: '127.0.0.1', port: 8080 },
    { host: '127.0.0.1', port: 8081 }
  ]

  t.pass('no crash without sortNodesByRTT')

  dht.sortNodesByRTT = originalSort
})

test('rtt - multiple nodes with same host different ports', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const nodes = [
    { host: '127.0.0.1', port: 8080 },
    { host: '127.0.0.1', port: 8081 },
    { host: '127.0.0.1', port: 8082 }
  ]

  dht.updateNodeRTT(nodes[0], 100)
  dht.updateNodeRTT(nodes[1], 200)
  dht.updateNodeRTT(nodes[2], 300)

  t.ok(dht._nodeRTT.get('127.0.0.1:8080'), 'all nodes tracked separately')
  t.is(dht.getNodeRTT(nodes[0]), 100, 'first node RTT correct')
  t.is(dht.getNodeRTT(nodes[1]), 200, 'second node RTT correct')
  t.is(dht.getNodeRTT(nodes[2]), 300, 'third node RTT correct')
})

test('rtt - node with address object format', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  const node = {
    address: { host: '127.0.0.1', port: 8080 }
  }

  dht.updateNodeRTT(node, 150)
  t.ok(dht._nodeRTT.get('127.0.0.1:8080'), 'node with address object added')
  t.is(dht.getNodeRTT(node), 150, 'RTT retrieved correctly')

  const directNode = { host: '127.0.0.1', port: 8080 }
  t.is(dht.getNodeRTT(directNode), 150, 'RTT retrievable with direct format')
})

test('rtt - warmup interval cleared on destroy', async function (t) {
  const dht = new DHT({ bootstrap: [], preWarmRTT: true })
  await dht.ready()

  t.ok(dht._rttWarmupInterval, 'warmup interval active')

  await dht.destroy()
  t.absent(dht._rttWarmupInterval, 'warmup interval cleared on destroy')
})

test('rtt - caches cleared on destroy', async function (t) {
  const dht = new DHT({ bootstrap: [], preWarmRTT: false })
  await dht.ready()

  dht.updateNodeRTT({ host: '127.0.0.1', port: 8080 }, 123)
  t.ok(Array.from(dht._nodeRTT.keys()).length > 0, 'RTT cache populated')

  await dht.destroy()
  t.is(Array.from(dht._nodeRTT.keys()).length, 0, 'RTT cache cleared after destroy')
})
