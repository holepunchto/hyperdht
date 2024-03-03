const test = require('brittle')
const HyperDHT = require('../')
const Persistent = require('../lib/persistent')
const { swarm } = require('./helpers')

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

test('mutableGet - commit on behalf of other node', async function (t) {
  const { bootstrap, nodes } = await swarm(t, 100)

  const dht = new HyperDHT({ bootstrap, seed: Buffer.alloc(32).fill('foo') })

  const records = [0, 1, 2].map((seq) => {
    const value = Buffer.from('Test-' + seq)

    return {
      seq,
      value,
      signature: Persistent.signMutable(seq, value, dht.defaultKeyPair)
    }
  })

  // Storing seq 1
  await nodes[30].mutableGet(dht.defaultKeyPair.publicKey, records[1])

  let saved = await nodes[3].mutableGet(dht.defaultKeyPair.publicKey)
  t.is(saved.seq, 1)

  // Storing seq 0
  const res = await nodes[30].mutableGet(dht.defaultKeyPair.publicKey, records[0])
  t.is(res.seq, 1, 'should not override seq 1')

  saved = await nodes[3].mutableGet(dht.defaultKeyPair.publicKey)
  t.absent(saved.local)
  t.is(saved.seq, 1, 'should not override seq 1')

  // Storing seq 2
  await nodes[30].mutableGet(dht.defaultKeyPair.publicKey, records[2])

  saved = await nodes[3].mutableGet(dht.defaultKeyPair.publicKey)
  t.is(saved.seq, 2)
  t.alike(saved.value, records[2].value)
  t.alike(saved.signature, records[2].signature)

  dht.destroy()
})
