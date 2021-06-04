const { test, swarm, destroy } = require('./helpers')

test('immutable put - get', async (bootstrap, { is }) => {
  const nodes = await swarm(bootstrap, 100)

  const { key } = await nodes[0].immutablePut(Buffer.from('testing'))

  const { id, value, token, from, to } = await nodes[30].immutableGet(key)

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
