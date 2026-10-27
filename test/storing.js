const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const c = require('compact-encoding')
const HyperDHT = require('../')
const m = require('../lib/messages')
const Persistent = require('../lib/persistent')
const { MAX_VALUE_SIZE } = require('../lib/constants')
const { swarm, createDHT } = require('./helpers')

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

test('max-size values store and serve', async function (t) {
  const { nodes } = await swarm(t)

  const value = b4a.alloc(MAX_VALUE_SIZE, 7)
  const { hash } = await nodes[0].immutablePut(value)
  const res = await nodes[1].immutableGet(hash)
  t.alike(res.value, value, 'max-size immutable value roundtrips')

  const keyPair = HyperDHT.keyPair()
  await nodes[0].mutablePut(keyPair, value)
  const mres = await nodes[1].mutableGet(keyPair.publicKey)
  t.alike(mres.value, value, 'max-size mutable value roundtrips')
})

test('immutable put rejects oversized values', async function (t) {
  const a = createDHT({ bootstrap: [] })
  t.teardown(() => a.destroy())

  const big = b4a.alloc(MAX_VALUE_SIZE + 1, 1)
  await t.exception(() => a.immutablePut(big), /VALUE_TOO_LARGE/, 'client-side reject')

  const persistent = new Persistent(null, {
    records: { maxSize: 100 },
    bumps: { maxSize: 100 },
    refreshes: { maxSize: 100 },
    mutables: { maxSize: 100 },
    immutables: { maxSize: 100 }
  })
  t.teardown(() => persistent.destroy())

  const target = b4a.allocUnsafe(32)
  sodium.crypto_generichash(target, big)
  persistent.onimmutableput({ target, token: b4a.alloc(32), value: big })
  t.absent(persistent.immutables.get(b4a.toString(target, 'hex')), 'storage node reject')

  const ok = b4a.alloc(MAX_VALUE_SIZE, 2)
  const okTarget = b4a.allocUnsafe(32)
  sodium.crypto_generichash(okTarget, ok)
  persistent.onimmutableput({ target: okTarget, token: b4a.alloc(32), value: ok, reply: () => {} })
  t.alike(persistent.immutables.get(b4a.toString(okTarget, 'hex')), ok, 'max-size still stored')
})

test('mutable put rejects oversized values', async function (t) {
  const a = createDHT({ bootstrap: [] })
  t.teardown(() => a.destroy())
  const keyPair = HyperDHT.keyPair()

  const big = b4a.alloc(MAX_VALUE_SIZE + 1, 1)
  await t.exception(() => a.mutablePut(keyPair, big), /VALUE_TOO_LARGE/, 'client-side reject')

  const persistent = new Persistent(null, {
    records: { maxSize: 100 },
    bumps: { maxSize: 100 },
    refreshes: { maxSize: 100 },
    mutables: { maxSize: 100 },
    immutables: { maxSize: 100 }
  })
  t.teardown(() => persistent.destroy())

  const target = b4a.allocUnsafe(32)
  sodium.crypto_generichash(target, keyPair.publicKey)
  const k = b4a.toString(target, 'hex')

  const signed = c.encode(m.mutablePutRequest, {
    publicKey: keyPair.publicKey,
    seq: 0,
    value: big,
    signature: b4a.alloc(64)
  })
  persistent.onmutableput({ target, token: b4a.alloc(32), value: signed })
  t.absent(persistent.mutables.get(k), 'storage node reject')

  const ok = b4a.alloc(MAX_VALUE_SIZE, 2)
  const okSigned = c.encode(m.mutablePutRequest, {
    publicKey: keyPair.publicKey,
    seq: 0,
    value: ok,
    signature: Persistent.signMutable(0, ok, keyPair)
  })
  persistent.onmutableput({ target, token: b4a.alloc(32), value: okSigned, reply: () => {} })
  t.ok(persistent.mutables.get(k), 'max-size still stored')
})
