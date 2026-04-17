const test = require('brittle')
const HyperDHT = require('../')
const { swarm } = require('./helpers')
const { createPHTNode } = require('prefix-hash-tree/node')

test('immutable put - get', async function (t) {
  const { nodes } = await swarm(t, 100)

  const { hash } = await nodes[30].immutablePut(Buffer.from('testing'))
  const res = await nodes[3].immutableGet(hash)

  t.is(Buffer.isBuffer(res.value), true)
  t.is(res.value.toString(), 'testing')
  t.is(typeof res.from, 'object')
  t.is(typeof res.from.host, 'string')
  t.is(typeof res.from.port, 'number')
  t.is(typeof res.to, 'object')
  t.is(typeof res.to.host, 'string')
  t.is(typeof res.to.port, 'number')
})

test('mutable put - get', async function (t) {
  const { nodes } = await swarm(t, 100)
  const keyPair = HyperDHT.keyPair()

  const put = await nodes[30].mutablePut(keyPair, Buffer.from('testing'))

  t.is(put.signature.length, 64)
  t.is(put.seq, 0)

  const res = await nodes[3].mutableGet(keyPair.publicKey)

  t.is(res.seq, 0)
  t.is(Buffer.isBuffer(res.value), true)
  t.is(Buffer.compare(res.signature, put.signature), 0)
  t.is(res.value.toString(), 'testing')
  t.is(typeof res.from, 'object')
  t.is(typeof res.from.host, 'string')
  t.is(typeof res.from.port, 'number')
  t.is(typeof res.to, 'object')
  t.is(typeof res.to.host, 'string')
  t.is(typeof res.to.port, 'number')
})

test('mutable put - put - get', async function (t) {
  const { nodes } = await swarm(t, 100)
  const keyPair = HyperDHT.keyPair()

  const put = await nodes[30].mutablePut(keyPair, Buffer.from('testing'))

  t.is(put.signature.length, 64)
  t.is(put.seq, 0)

  const put2 = await nodes[25].mutablePut(keyPair, Buffer.from('testing two'), { seq: 2 })

  t.is(put2.signature.length, 64)
  t.is(put2.seq, 2)

  const res = await nodes[3].mutableGet(keyPair.publicKey)

  t.is(res.seq, 2)
  t.is(Buffer.isBuffer(res.value), true)
  t.is(Buffer.compare(res.signature, put2.signature), 0)
  t.is(res.value.toString(), 'testing two')
})

test('PHT node put - get', async function (t) {
  const { nodes } = await swarm(t, 100, [], { experimentalPHT: true })
  const keyPair = HyperDHT.keyPair()
  const n = createPHTNode({ label: '010011', child0: '0100110', child1: '0100111' })

  const p = await nodes[30].phtNodePut(keyPair, Buffer.from('myTestTree'), n)

  t.is(p.target.length, 32)
  t.is(p.signature.length, 64)
  t.is(typeof p.indexID, 'string')
  t.is(Buffer.compare(Buffer.alloc(32), p.connectionKey), 0)

  const res = await nodes[30].phtNodeGet(p.target)
  const { publicKey, treeID, phtNode, signature } = res

  t.is(Buffer.compare(publicKey, keyPair.publicKey), 0)
  t.is(treeID.toString(), 'myTestTree')
  t.alike(phtNode, n)
  t.is(Buffer.compare(signature, p.signature), 0)
  t.is(typeof res.from, 'object')
  t.is(typeof res.from.host, 'string')
  t.is(typeof res.from.port, 'number')
  t.is(typeof res.to, 'object')
  t.is(typeof res.to.host, 'string')
  t.is(typeof res.to.port, 'number')
})
