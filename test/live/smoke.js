// This test should not be run as part of the normal test flow as it interacts
// with the live DHT.

const test = require('brittle')
const DHT = require('../..')

test('live mutable put - get', async function (t) {
  const node = new DHT()
  const keyPair = DHT.keyPair()

  const put = await node.mutablePut(keyPair, Buffer.from('testing'))

  t.is(put.signature.length, 64)
  t.is(put.seq, 0)

  const get = await node.mutableGet(keyPair.publicKey)

  t.is(get.seq, 0)
  t.is(Buffer.isBuffer(get.value), true)
  t.is(Buffer.compare(get.signature, put.signature), 0)
  t.is(get.value.toString(), 'testing')

  await node.destroy()
})
