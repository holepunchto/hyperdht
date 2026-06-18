const test = require('brittle')
const b4a = require('b4a')
const tmp = require('test-tmp')
const NamespacedDB = require('namespaced-native')
const DHT = require('../')
const Snapshotter = require('../lib/snapshotter')
const { swarm } = require('./helpers')
const { DB_NS, SNAPSHOT_KEYS } = require('../lib/constants')

test('snapshotter successive writes', async function (t) {
  const node = new DHT({ dbPath: await tmp(t), bootstrap: [], ephemeral: true })
  t.teardown(() => node.destroy())

  const key = b4a.from('test-successive-writes')
  const count = []

  const s = new Snapshotter(node, 'test-namespace', key, 10, () => {
    count.push(count.length + 1)
    if (count.length === 5) s.stop()
    return b4a.from(JSON.stringify(count))
  })

  s.start()
  await s.done

  t.alike(count, [1, 2, 3, 4, 5])

  const n = await node.db.namespace('test-namespace')
  const result = await n.get(key)

  t.alike(JSON.parse(b4a.toString(result)), [1, 2, 3, 4, 5])
})

test('snapshotter suspend - resume', async function (t) {
  const node = new DHT({ dbPath: await tmp(t), bootstrap: [], ephemeral: true })
  t.teardown(() => node.destroy())

  const key = b4a.from('test-suspend-resume')
  const count = []

  const s = new Snapshotter(node, 'test-namespace', key, 10, () => {
    count.push(count.length + 1)

    if (count.length === 2) {
      s.suspend()
    } else if (count.length === 5) {
      s.stop()
    }

    return b4a.from(JSON.stringify(count))
  })

  s.start()

  // 2s is generous against a 10ms write interval - if suspend failed to pause the write
  // loop, we'd expect to see those writes reflected
  await new Promise((resolve) => setTimeout(resolve, 2000))

  t.alike(count, [1, 2])

  const n = await node.db.namespace('test-namespace')
  const first = await n.get(key)

  t.alike(JSON.parse(b4a.toString(first)), [1, 2])

  s.resume()
  await s.done

  t.alike(count, [1, 2, 3, 4, 5])

  const second = await n.get(key)
  t.alike(JSON.parse(b4a.toString(second)), [1, 2, 3, 4, 5])
})

test('routing table snapshot write', async function (t) {
  const testnet = await swarm(t, 4)

  const peer = await testnet.createNode(t)
  await peer.fullyBootstrapped()

  // Snapshotter's first write is immediately upon fullyBootstrapped, so 2s is generous
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const ns = await peer.db.namespace(DB_NS.SNAPSHOTS)
  const s = await ns.get(b4a.from(SNAPSHOT_KEYS.ROUTING_TABLE))
  t.ok(s !== null)

  const snapshot = JSON.parse(b4a.toString(s))
  t.ok(snapshot.length > 0)

  const actualRoutingTable = new Set(peer.toArray().map(({ host, port }) => `${host}:${port}`))

  for (const { host, port } of snapshot) t.ok(actualRoutingTable.has(`${host}:${port}`))
})

test('warm bootstrap from restored routing table', async function (t) {
  const testnet = await swarm(t, 4)

  const snapshot = testnet.nodes.map((node) => {
    const { host, port } = node.address()
    return { host, port }
  })

  const dbPath = await tmp(t)
  const db = new NamespacedDB({ path: dbPath })
  const ns = await db.namespace(DB_NS.SNAPSHOTS)

  await ns.put([
    {
      key: b4a.from(SNAPSHOT_KEYS.ROUTING_TABLE),
      value: b4a.from(JSON.stringify(snapshot))
    }
  ])

  await db.close()

  const node = new DHT({
    dbPath,
    warmBootstrap: true,
    bootstrap: [],
    host: '127.0.0.1',
    ephemeral: true
  })

  t.teardown(() => node.destroy())

  await node.fullyBootstrapped()

  const actualRoutingTable = new Set(node.toArray().map(({ host, port }) => `${host}:${port}`))

  for (const { host, port } of snapshot) t.ok(actualRoutingTable.has(`${host}:${port}`))

  // Control subject - warm bootstrap with no routing table snapshot
  const control = new DHT({
    dbPath: await tmp(t),
    warmBootstrap: true,
    bootstrap: [],
    host: '127.0.0.1',
    ephemeral: true
  })

  t.teardown(() => control.destroy())

  await control.fullyBootstrapped()

  t.is(control.toArray().length, 0)
})
