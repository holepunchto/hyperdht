const test = require('brittle')
const b4a = require('b4a')
const { swarm } = require('./helpers')
const { DB_NS, SNAPSHOT_KEYS } = require('../lib/constants')

test('routing table snapshot write', async function (t) {
  const testnet = await swarm(t, 4)

  const peer = await testnet.createNode(t)
  await peer.fullyBootstrapped()

  // Snapshotter writes immediately on start, before the first sleep, so 5s is generous
  await new Promise((resolve) => setTimeout(resolve, 5000))

  const ns = await peer.db.namespace(DB_NS.SNAPSHOTS)
  const s = await ns.get(b4a.from(SNAPSHOT_KEYS.ROUTING_TABLE))
  t.ok(s !== null)

  const snapshot = JSON.parse(b4a.toString(s))
  t.ok(snapshot.length > 0)

  const table = new Set(peer.toArray().map((node) => `${node.host}:${node.port}`))

  for (const node of snapshot) t.ok(table.has(`${node.host}:${node.port}`))
})
