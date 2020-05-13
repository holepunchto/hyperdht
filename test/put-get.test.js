'use strict'
const { test } = require('tap')
const { randomBytes } = require('crypto')
const {
  crypto_sign_BYTES: signSize,
  crypto_sign_verify_detached: verify
} = require('sodium-native')
const { once, promisifyMethod, whenifyMethod, done, when } = require('nonsynchronous')
const dht = require('../')
const { dhtBootstrap } = require('./util')

test('immutable get - key must be buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(() => peer.immutable.get('test'), 'Key must be a buffer')
  peer.destroy()
  closeDht()
})

test('immutable put - value must be buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(() => peer.immutable.put('test', () => {}), 'Value must be a buffer')
  peer.destroy()
  closeDht()
})

test('immutable put - value size must be <= 1000 bytes', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(
    () => peer.immutable.put(Buffer.alloc(1001), () => {}),
    'Value size must be <= 1000'
  )
  peer.destroy()
  closeDht()
})

test('immutable put - callback is required', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(
    () => peer.immutable.put(Buffer.alloc(10)),
    'Callback is required'
  )
  peer.destroy()
  closeDht()
})

test('immutable put/get', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  promisifyMethod(peer.immutable, 'put')
  promisifyMethod(peer2.immutable, 'get')
  const input = Buffer.from('test')
  const key = await peer.immutable.put(input)
  const value = await peer2.immutable.get(key)
  is(input.equals(value), true)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('immutable put/get - same peer', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  promisifyMethod(peer.immutable, 'put')
  promisifyMethod(peer.immutable, 'get')
  const input = Buffer.from('test')
  const key = await peer.immutable.put(input)
  const value = await peer.immutable.get(key)
  is(input.equals(value), true)
  peer.destroy()
  closeDht()
})

test('immutable put, get stream', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const input = Buffer.from('test')
  promisifyMethod(peer.immutable, 'put')
  const key = await peer.immutable.put(input)
  const stream = peer2.immutable.get(key)
  const [{ value }] = await once(stream, 'data')
  is(input.equals(value), true)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('immutable put, get stream - same peer', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const input = Buffer.from('test')
  promisifyMethod(peer.immutable, 'put')
  const key = await peer.immutable.put(input)
  const stream = peer.immutable.get(key)
  const [{ value }] = await once(stream, 'data')
  is(input.equals(value), true)
  peer.destroy()
  closeDht()
})

test('immutable put, get stream - same peer, w/ get cb', async ({ is, plan }) => {
  plan(3)
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const input = Buffer.from('test')
  promisifyMethod(peer.immutable, 'put')
  const key = await peer.immutable.put(input)
  const stream = peer.immutable.get(key, (err, value) => {
    is(err, null)
    is(input.equals(value), true)
  })
  const [{ value }] = await once(stream, 'data')
  is(input.equals(value), true)
  peer.destroy()
  closeDht()
})

test('immutable put, get stream - same peer, w/ get cb, stream destroy', async ({ is, plan }) => {
  plan(1)
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const input = Buffer.from('test')
  promisifyMethod(peer.immutable, 'put')
  const key = await peer.immutable.put(input)
  const testErr = Error('test')
  const stream = peer.immutable.get(key, (err) => {
    is(err, testErr)
    peer.destroy()
    closeDht()
  })
  stream.destroy(testErr)
  try { await once(stream, 'end') } catch (e) {}
})

test('immutable get non-existant', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  promisifyMethod(peer.immutable, 'put')
  promisifyMethod(peer2.immutable, 'get')
  const key = randomBytes(32)
  const value = await peer2.immutable.get(key)
  is(value, null)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('immutable get propagates query stream error', async ({ is, plan }) => {
  plan(1)
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  promisifyMethod(peer.immutable, 'put')
  whenifyMethod(peer2.immutable, 'get')
  const input = Buffer.from('test')
  const key = await peer.immutable.put(input)
  const stream = peer2.immutable.get(key, (err) => {
    is(err.message, 'test')
  })
  const until = peer2.immutable.get[done]
  stream.emit('error', Error('test'))
  await until
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('immutable put propagates query stream error', async ({ is, plan }) => {
  plan(1)
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  whenifyMethod(peer.immutable, 'put')
  const input = Buffer.from('test')
  const stream = peer.immutable.put(input, (err) => {
    is(err.message, 'test')
  })
  const until = peer.immutable.put[done]
  stream.emit('error', Error('test'))
  await until
  peer.destroy()
  closeDht()
})

test('immutable corrupt hash update', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const key = Buffer.alloc(32).fill(99)
  const value = Buffer.from('test')
  const stream = peer.update('immutable-store', key, value)
  stream.resume()
  const [err] = await once(stream, 'warning')
  is(err.message, 'ERR_INVALID_INPUT')
  peer.destroy()
  closeDht()
})

test('immutable get corrupt hashes/values are filtered out', async ({ fail, pass }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const val = Buffer.from('test')
  promisifyMethod(peer2.immutable, 'put')
  const key = await peer2.immutable.put(val)
  const stream = peer.immutable.get(key)
  const { _map } = stream
  stream._map = (result) => {
    result.value = Buffer.from('fake')
    return _map(result)
  }
  stream.resume()
  stream.on('data', () => fail('should not be any results'))
  await once(stream, 'end')
  pass('corrupt data was filtered')
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('tbd', async ({ fail, pass }) => {

})

test('mutable.keypair', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const { publicKey, secretKey } = peer.mutable.keypair()
  is(publicKey instanceof Buffer, true)
  is(publicKey.length, 32)
  is(secretKey instanceof Buffer, true)
  is(secretKey.length, 64)
  peer.destroy()
  closeDht()
})

test('mutable.salt', async ({ is, throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const salt = peer.mutable.salt()
  is(salt instanceof Buffer, true)
  is(salt.length, 32)
  is(peer.mutable.salt(64).length, 64)
  throws(() => peer.mutable.salt(15))
  throws(() => peer.mutable.salt(65))
  peer.destroy()
  closeDht()
})

test('mutable.signable', async ({ is, same }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const salt = peer.mutable.salt()
  const value = Buffer.from('test')
  same(
    peer.mutable.signable(value),
    Buffer.from('3:seqi0e1:v4:test')
  )
  same(
    peer.mutable.signable(value, { seq: 1 }),
    Buffer.from('3:seqi1e1:v4:test')
  )
  same(
    peer.mutable.signable(value, { salt }),
    Buffer.concat([
      Buffer.from('4:salt'),
      Buffer.from(`${salt.length}:`),
      salt,
      Buffer.from('3:seqi0e1:v4:test')
    ])
  )
  peer.destroy()
  closeDht()
})

test('mutable signable - salt must be a buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(() => peer.mutable.signable(Buffer.from('test'), { salt: 'no' }), 'salt must be a buffer')
  peer.destroy()
  closeDht()
})

test('mutable signable - salt size must be no greater than 64 bytes', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(
    () => peer.mutable.signable(Buffer.from('test'), { salt: Buffer.alloc(65) }),
    'salt size must be no greater than 64 bytes'
  )
  peer.destroy()
  closeDht()
})

test('mutable signable - value must be buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(() => peer.mutable.signable('test', { keypair }), 'Value must be a buffer')
  peer.destroy()
  closeDht()
})

test('mutable signable - value size must be <= 1000 bytes', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(
    () => peer.mutable.signable(Buffer.alloc(1001), { keypair }),
    'Value size must be <= 1000'
  )
  peer.destroy()
  closeDht()
})

test('mutable.sign', async ({ is, throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const { publicKey } = keypair
  const salt = peer.mutable.salt()
  const value = Buffer.from('test')
  is(
    verify(
      peer.mutable.sign(value, { keypair }),
      peer.mutable.signable(value),
      publicKey
    ),
    true
  )
  is(
    verify(
      peer.mutable.sign(value, { salt, keypair }),
      peer.mutable.signable(value, { salt }),
      publicKey
    ),
    true
  )
  is(
    verify(
      peer.mutable.sign(value, { seq: 2, keypair }),
      peer.mutable.signable(value, { seq: 2 }),
      publicKey
    ),
    true
  )
  peer.destroy()
  closeDht()
})

test('mutable sign - salt must be a buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(() => peer.mutable.sign(Buffer.from('test'), { salt: 'no' }), 'salt must be a buffer')
  peer.destroy()
  closeDht()
})

test('mutable sign - salt size must be >= 16 bytes and <= 64 bytes', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(
    () => peer.mutable.sign(Buffer.from('test'), { salt: Buffer.alloc(15) }),
    'salt size must be between 16 and 64 bytes (inclusive)'
  )
  throws(
    () => peer.mutable.sign(Buffer.from('test'), { salt: Buffer.alloc(65) }),
    'salt size must be between 16 and 64 bytes (inclusive)'
  )
  peer.destroy()
  closeDht()
})

test('mutable sign - value must be buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(() => peer.mutable.sign('test', { keypair }), 'Value must be a buffer')
  peer.destroy()
  closeDht()
})

test('mutable sign - options are required', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(() => peer.mutable.sign('test'), 'Options are required')
  peer.destroy()
  closeDht()
})

test('mutable sign - value size must be <= 1000 bytes', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(
    () => peer.mutable.sign(Buffer.alloc(1001), { keypair }),
    'Value size must be <= 1000'
  )
  peer.destroy()
  closeDht()
})

test('mutable sign - keypair option is required', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(
    () => peer.mutable.sign(Buffer.alloc(1001), {}),
    'keypair is required'
  )
  peer.destroy()
  closeDht()
})

test('mutable sign - keypair must have secretKey which must be a buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  keypair.secretKey = 'nope'
  throws(
    () => peer.mutable.sign(Buffer.alloc(1001), { keypair }),
    'keypair.secretKey is required'
  )
  delete keypair.secretKey
  throws(
    () => peer.mutable.sign(Buffer.alloc(1001), { keypair }),
    'keypair.secretKey is required'
  )
  peer.destroy()
  closeDht()
})

test('mutable get - key must be buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(() => peer.mutable.get('test'), 'Key must be a buffer')
  peer.destroy()
  closeDht()
})

test('mutable get - seq must be number', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(() => peer.mutable.get(Buffer.from('test'), { seq: 'no' }), 'seq should be a number')
  peer.destroy()
  closeDht()
})

test('mutable get - salt must be a buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(() => peer.mutable.get(Buffer.from('test'), { salt: 'no' }), 'salt must be a buffer')
  peer.destroy()
  closeDht()
})

test('mutable get - salt size must be no greater than 64 bytes', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(
    () => peer.mutable.get(Buffer.from('test'), { salt: Buffer.alloc(65) }),
    'salt size must be no greater than 64 bytes'
  )
  peer.destroy()
  closeDht()
})

test('mutable put - value must be buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(() => peer.mutable.put('test', { keypair }, () => {}), 'Value must be a buffer')
  peer.destroy()
  closeDht()
})

test('mutable put - options are required', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(() => peer.mutable.put('test', () => {}), 'Options are required')
  peer.destroy()
  closeDht()
})

test('mutable put - callback is required', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(() => peer.mutable.put('test', { keypair }), 'Callback is required')
  peer.destroy()
  closeDht()
})

test('mutable put - value size must be <= 1000 bytes', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(
    () => peer.mutable.put(Buffer.alloc(1001), { keypair }, () => {}),
    'Value size must be <= 1000'
  )
  peer.destroy()
  closeDht()
})

test('mutable put - keypair option is required', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  throws(
    () => peer.mutable.put(Buffer.alloc(1001), {}, () => {}),
    'keypair is required'
  )
  peer.destroy()
  closeDht()
})

test('mutable put - keypair must have secretKey which must be a buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  keypair.secretKey = 'nope'
  throws(
    () => peer.mutable.put(Buffer.alloc(1001), { keypair }, () => {}),
    'keypair.secretKey is required'
  )
  delete keypair.secretKey
  throws(
    () => peer.mutable.put(Buffer.alloc(1001), { keypair }, () => {}),
    'keypair.secretKey is required'
  )
  peer.destroy()
  closeDht()
})

test('mutable put - keypair must have secretKey which must be a buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  keypair.secretKey = 'nope'
  throws(
    () => peer.mutable.put(Buffer.alloc(1001), { keypair }, () => {}),
    'keypair.secretKey is required'
  )
  delete keypair.secretKey
  throws(
    () => peer.mutable.put(Buffer.alloc(1001), { keypair }, () => {}),
    'keypair.secretKey is required'
  )
  peer.destroy()
  closeDht()
})

test('mutable put - seq must be number', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(
    () => peer.mutable.put(Buffer.from('test'), { keypair, seq: 'no' }),
    'seq should be a number'
  )
  peer.destroy()
  closeDht()
})

test('mutable put - salt must be a buffer', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(
    () => peer.mutable.put(Buffer.from('test'), { keypair, salt: 'no' }),
    'salt must be a buffer')
  peer.destroy()
  closeDht()
})

test('mutable put - salt size must be >= 16 bytes and <= 64 bytes', async ({ throws }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  throws(
    () => peer.mutable.put(Buffer.from('test'), { keypair, salt: Buffer.alloc(15) }),
    'salt size must be between 16 and 64 bytes (inclusive)'
  )
  throws(
    () => peer.mutable.put(Buffer.from('test'), { keypair, salt: Buffer.alloc(65) }),
    'salt size must be between 16 and 64 bytes (inclusive)'
  )
  peer.destroy()
  closeDht()
})

test('mutable put/get', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  promisifyMethod(peer.mutable, 'put')
  promisifyMethod(peer2.mutable, 'get')
  const input = Buffer.from('test')
  const { key } = await peer.mutable.put(input, { keypair })
  const { value } = await peer2.mutable.get(key)
  is(input.equals(value), true)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable put/get - same peer', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  promisifyMethod(peer.mutable, 'put')
  promisifyMethod(peer.mutable, 'get')
  const input = Buffer.from('test')
  const { key } = await peer.mutable.put(input, { keypair })
  const { value } = await peer.mutable.get(key)
  is(input.equals(value), true)
  peer.destroy()
  closeDht()
})

test('mutable put/get - signature option', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const { publicKey } = keypair
  promisifyMethod(peer.mutable, 'put')
  promisifyMethod(peer.mutable, 'get')
  const input = Buffer.from('test')
  const signature = peer.mutable.sign(input, { keypair })
  const { key } = await peer.mutable.put(input, {
    signature,
    keypair: { publicKey }
  })
  const { value } = await peer.mutable.get(key)
  is(input.equals(value), true)
  peer.destroy()
  closeDht()
})

test('mutable put/get - salted signature option', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const salt = peer.mutable.salt()
  const keypair = peer.mutable.keypair()
  const { publicKey } = keypair
  promisifyMethod(peer.mutable, 'put')
  promisifyMethod(peer.mutable, 'get')
  const input = Buffer.from('test')
  const signature = peer.mutable.sign(input, { keypair, salt })
  const { key } = await peer.mutable.put(input, {
    signature,
    salt,
    keypair: { publicKey }
  })
  const { value } = await peer.mutable.get(key, { salt })
  is(input.equals(value), true)
  peer.destroy()
  closeDht()
})

test('mutable put, get stream', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  promisifyMethod(peer.mutable, 'put')
  const input = Buffer.from('test')
  const { key } = await peer.mutable.put(input, { keypair })
  const stream = peer2.mutable.get(key)
  const [{ value }] = await once(stream, 'data')
  is(input.equals(value), true)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable put, get stream - same peer', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  promisifyMethod(peer.mutable, 'put')
  const input = Buffer.from('test')
  const { key } = await peer.mutable.put(input, { keypair })
  const stream = peer.mutable.get(key)
  const [{ value }] = await once(stream, 'data')
  is(input.equals(value), true)
  peer.destroy()
  closeDht()
})

test('mutable put/get latest seq', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  promisifyMethod(peer.mutable, 'put')
  promisifyMethod(peer2.mutable, 'get')
  const input = Buffer.from('test')
  let seq = 1
  const { key } = await peer.mutable.put(input, { keypair, seq })
  seq = 0
  const { value } = await peer2.mutable.get(key, { seq })
  is(input.equals(value), true)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable put/get update', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const peer3 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  promisifyMethod(peer.mutable, 'put')
  promisifyMethod(peer.mutable, 'get')
  promisifyMethod(peer2.mutable, 'get')
  promisifyMethod(peer3.mutable, 'put')
  const input = Buffer.from('test')
  let seq = 0
  const { key } = await peer.mutable.put(input, { keypair, seq })
  const { value } = await peer2.mutable.get(key, { seq })
  is(input.equals(value), true)
  const update = Buffer.from('test2')
  seq += 1
  await peer3.mutable.put(update, { keypair, seq })
  const { value: updatedValue } = await peer.mutable.get(key, { seq })
  is(updatedValue.equals(update), true)
  peer.destroy()
  peer2.destroy()
  peer3.destroy()
  closeDht()
})

test('mutable put/get w/ salt + updates', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const peer3 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  promisifyMethod(peer.mutable, 'put')
  promisifyMethod(peer.mutable, 'get')
  promisifyMethod(peer2.mutable, 'get')
  promisifyMethod(peer3.mutable, 'put')
  const input = Buffer.from('test')
  const salt = peer.mutable.salt()
  const salt2 = peer.mutable.salt()
  const { key } = await peer.mutable.put(input, { keypair, salt })
  const { value } = await peer2.mutable.get(key, { salt })
  is(input.equals(value), true)
  const update = Buffer.from('test2')
  await peer3.mutable.put(update, { keypair, salt2 })
  const { value: updatedValue } = await peer.mutable.get(key, { salt2 })
  const { value: sameValue } = await peer2.mutable.get(key, { salt })
  is(input.equals(sameValue), true)
  is(updatedValue.equals(update), true)
  peer.destroy()
  peer2.destroy()
  peer3.destroy()
  closeDht()
})

test('mutable put, immutable get', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  promisifyMethod(peer.mutable, 'put')
  promisifyMethod(peer2.immutable, 'get')
  const input = Buffer.from('test')
  const { key } = await peer.mutable.put(input, { keypair })
  const value = await peer2.immutable.get(key)
  is(value, null)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('immutable put, mutable get', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  promisifyMethod(peer.immutable, 'put')
  promisifyMethod(peer2.mutable, 'get')
  const input = Buffer.from('test')
  const key = await peer.immutable.put(input)
  const { value } = await peer2.mutable.get(key)
  is(value, null)
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable get non-existant', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  promisifyMethod(peer.mutable, 'get')
  const key = keypair.publicKey
  const { value } = await peer.mutable.get(key)
  is(value, null)
  peer.destroy()
  closeDht()
})

test('mutable put/get update new value with same seq', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  whenifyMethod(peer.mutable, 'put')
  promisifyMethod(peer2.mutable, 'get')
  const input = Buffer.from('test')
  const seq = 0
  const key = keypair.publicKey
  peer.mutable.put(input, { keypair, seq }, () => {})
  await peer.mutable.put[done]
  const { value } = await peer2.mutable.get(key, { seq })
  is(input.equals(value), true)
  const update = Buffer.from('test2')
  const until = when()
  peer.mutable.put(update, { keypair, seq }, (err) => {
    is(err.message, 'ERR_INVALID_SEQ')
    until()
  })
  await until.done()
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable put/get update new value with lower seq', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  whenifyMethod(peer.mutable, 'put')
  promisifyMethod(peer2.mutable, 'get')
  const input = Buffer.from('test')
  const seq = 2
  const key = keypair.publicKey
  peer.mutable.put(input, { keypair, seq }, () => {})
  await peer.mutable.put[done]
  const { value } = await peer2.mutable.get(key, { seq })
  is(input.equals(value), true)
  const update = Buffer.from('test2')
  const until = when()
  peer.mutable.put(update, { keypair, seq: 1 }, (err) => {
    is(err.message, 'ERR_SEQ_MUST_EXCEED_CURRENT')
    until()
  })
  await until.done()
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable put/get update with same value with same seq', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  whenifyMethod(peer.mutable, 'put')
  promisifyMethod(peer2.mutable, 'get')
  const input = Buffer.from('test')
  const seq = 0
  const key = keypair.publicKey
  peer.mutable.put(input, { keypair, seq }, () => {})
  await peer.mutable.put[done]
  const { value } = await peer2.mutable.get(key, { seq })
  is(input.equals(value), true)
  const until = when()
  peer.mutable.put(input, { keypair, seq }, (err) => {
    is(err.message, 'ERR_SEQ_MUST_EXCEED_CURRENT')
    until()
  })
  await until.done()
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable get propagates query stream error', async ({ is, plan }) => {
  plan(1)
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  promisifyMethod(peer.mutable, 'put')
  whenifyMethod(peer2.mutable, 'get')
  const keypair = peer.mutable.keypair()
  const input = Buffer.from('test')
  const { key } = await peer.mutable.put(input, { keypair })
  const stream = peer2.mutable.get(key, { keypair }, (err) => {
    is(err.message, 'test')
  })
  const until = peer2.mutable.get[done]
  stream.emit('error', Error('test'))
  await until
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable put propagates query stream error', async ({ is, plan }) => {
  plan(1)
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  whenifyMethod(peer.immutable, 'put')
  const input = Buffer.from('test')
  const keypair = peer.mutable.keypair()
  const stream = peer.mutable.put(input, { keypair }, (err) => {
    is(err.message, 'test')
  })
  stream.emit('error', Error('test'))
  peer.destroy()
  closeDht()
})

test('mutable update with null value is handled', async ({ pass }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const stream = peer.update('mutable-store', keypair.publicKey, {
    value: null, signature: Buffer.alloc(signSize)
  })
  stream.resume()
  await once(stream, 'end')
  pass('null value handled')
  peer.destroy()
  closeDht()
})

test('mutable update with null signature is handled', async ({ pass }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const stream = peer.update('mutable-store', keypair.publicKey, {
    value: Buffer.from('test'), signature: null
  })
  stream.resume()
  await once(stream, 'end')
  pass('null signature handled')
  peer.destroy()
  closeDht()
})

test('mutable corrupt value update', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const value = Buffer.from('test')
  const { update } = peer
  peer.update = (cmd, key, obj) => {
    if (cmd === 'mutable-store') {
      obj.value = Buffer.from('fake')
    }
    return update.call(peer, cmd, key, obj)
  }
  const stream = peer.mutable.put(value, { keypair }, () => {})
  stream.resume()
  const [err] = await once(stream, 'warning')
  is(err.message, 'ERR_INVALID_INPUT')
  peer.destroy()
  closeDht()
})

test('mutable corrupt signature update', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const value = Buffer.from('test')
  const { update } = peer
  peer.update = (cmd, key, obj) => {
    if (cmd === 'mutable-store') {
      obj.signature = Buffer.alloc(signSize)
    }
    return update.call(peer, cmd, key, obj)
  }
  const stream = peer.mutable.put(value, { keypair }, () => {})
  stream.resume()
  const [err] = await once(stream, 'warning')
  is(err.message, 'ERR_INVALID_INPUT')
  peer.destroy()
  closeDht()
})

test('mutable corrupt salt update', async ({ is }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const salt = peer.mutable.salt()
  const value = Buffer.from('test')
  const { update } = peer
  peer.update = (cmd, key, obj) => {
    if (cmd === 'mutable-store') {
      obj.salt = Buffer.alloc(32)
    }
    return update.call(peer, cmd, key, obj)
  }
  const stream = peer.mutable.put(value, { keypair, salt }, () => {})
  stream.resume()
  const [err] = await once(stream, 'warning')
  is(err.message, 'ERR_INVALID_INPUT')
  peer.destroy()
  closeDht()
})

test('mutable get corrupt values are filtered out', async ({ fail, pass }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const val = Buffer.from('test')
  promisifyMethod(peer2.mutable, 'put')
  const { key } = await peer2.mutable.put(val, { keypair })
  const stream = peer.mutable.get(key)
  const { _map } = stream
  stream._map = (result) => {
    result.value = { value: Buffer.from('fake') }
    return _map(result)
  }
  stream.resume()
  stream.on('data', () => fail('should not be any results'))
  await once(stream, 'end')
  pass('corrupt data was filtered')
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable get corrupt signatures are filtered out', async ({ fail, pass }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const val = Buffer.from('test')
  promisifyMethod(peer2.mutable, 'put')
  const { key } = await peer2.mutable.put(val, { keypair })
  const stream = peer.mutable.get(key)
  const { _map } = stream
  stream._map = (result) => {
    result.signature = Buffer.from('fake')
    return _map(result)
  }
  stream.resume()
  stream.on('data', ({ signature }) => {
    if (signature.toString() === 'fake') fail('corrupt signature was not filtered')
  })
  await once(stream, 'end')
  pass('corrupt data was filtered')
  peer.destroy()
  peer2.destroy()
  closeDht()
})

test('mutable get corrupt salts are filtered out', async ({ fail, pass }) => {
  const { bootstrap, closeDht } = await dhtBootstrap()
  const peer = dht({ bootstrap })
  const peer2 = dht({ bootstrap })
  const keypair = peer.mutable.keypair()
  const salt = peer.mutable.salt()
  const val = Buffer.from('test')
  promisifyMethod(peer2.mutable, 'put')
  const { key } = await peer2.mutable.put(val, { keypair, salt })
  const stream = peer.mutable.get(key, { salt })
  const { _map } = stream
  stream._map = (result) => {
    result.salt = Buffer.alloc(32)
    return _map(result)
  }
  stream.resume()
  stream.on('data', ({ signature }) => {
    if (signature.toString() === 'fake') fail('corrupt signature was not filtered')
  })
  await once(stream, 'end')
  pass('corrupt data was filtered')
  peer.destroy()
  peer2.destroy()
  closeDht()
})
