'use strict'
const HyperDHT = require('../')
const { test, swarm, destroy } = require('./helpers')

test('immutable put - get', async (bootstrap, { is }) => {
  const nodes = await swarm(bootstrap, 100)

  const { key } = await nodes[30].immutablePut(Buffer.from('testing'))

  const { id, value, token, from, to } = await nodes[3].immutableGet(key)

  is(id.length, 32)
  is(Buffer.isBuffer(value), true)
  is(value.toString(), 'testing')
  is(token.length, 32)
  is(typeof from, 'object')
  is(typeof from.host, 'string')
  is(typeof from.port, 'number')
  is(typeof to, 'object')
  is(typeof to.host, 'string')
  is(typeof to.port, 'number')

  destroy(nodes)
})

test('mutable put - get', async (bootstrap, { is }) => {
  const nodes = await swarm(bootstrap, 100)
  const keyPair = HyperDHT.keyPair()

  const put = await nodes[30].mutablePut(Buffer.from('testing'), { keyPair })
  is(put.signature.length, 64)
  is(put.seq, 0)
  const { id, value, signature, seq, token, from, to } = await nodes[3].mutableGet(keyPair.publicKey)

  is(seq, 0)
  is(id.length, 32)
  is(Buffer.isBuffer(value), true)
  is(Buffer.compare(put.signature, signature), 0)
  is(value.toString(), 'testing')
  is(token.length, 32)
  is(typeof from, 'object')
  is(typeof from.host, 'string')
  is(typeof from.port, 'number')
  is(typeof to, 'object')
  is(typeof to.host, 'string')
  is(typeof to.port, 'number')

  destroy(nodes)
})
