const { test, swarm, destroy } = require('./helpers')
const HyperDHT = require('../')

test('listen and connect', async function (bootstrap, t) {
  const nodes = await swarm(bootstrap, 10)
  const keyPair = HyperDHT.keyPair()

  const server = nodes[0].createServer(function (connection) {
    t.pass('server got connection')

    connection.on('data', function (data) {
      t.pass('server received data')
      connection.write(Buffer.concat([Buffer.from('echo: '), data]))
    })

    connection.on('end', function () {
      connection.end()
    })
  })

  await server.listen(keyPair)

  t.pass('listening')

  const connection = nodes[nodes.length - 1].connect(keyPair.publicKey)

  connection.write(Buffer.from('hello'))

  await new Promise((resolve) => connection.once('open', resolve))
  t.pass('connected')

  const data = await new Promise((resolve) => connection.once('data', resolve))

  t.same(data, Buffer.from('echo: hello'), 'echoed data')

  connection.end()
  await server.close()

  destroy(nodes)
})
