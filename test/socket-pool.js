const test = require('brittle')
const SocketPool = require('../lib/socket-pool')
const { swarm } = require('./helpers')

test('pair', async function (t) {
  t.plan(3)

  const [dht] = await swarm(t)

  const pool = new SocketPool(dht)
  t.teardown(() => pool.destroy())

  const a = pool.get()
  const b = pool.get()

  const stream = a.connect(1, 2, b.address().port)
  stream.end(Buffer.from('hello'))

  pool.pair(2, (socket, id, address) => {
    t.is(socket, b)
    t.is(id, 2)

    const stream = b.connect(2, 1, address.port)

    stream.on('data', (data) => {
      t.alike(data, Buffer.from('hello'))
      stream.end()
    })
  })
})
