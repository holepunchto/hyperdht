const test = require('brittle')
const { once } = require('events')
const { swarm } = require('./helpers')

test('connection pool, client side', async function (t) {
  const [a, b] = await swarm(t)

  const server = a.createServer((socket) => {
    t.pass('connection on server')
    socket.end()
  })

  await server.listen()

  const pool = b.pool()
  pool.on('connection', () => t.pass('connection on pool'))

  const open = t.test('open')
  open.plan(1)

  const socket = b.connect(server.publicKey, { pool })
  socket
    .on('open', () => {
      open.pass('stream opened')
    })
    .end()

  t.is(socket, b.connect(server.publicKey, { pool }))

  await open

  await server.close()
})

test('connection pool, server side', async function (t) {
  const [a, b] = await swarm(t)

  const pool = a.pool()
  pool.on('connection', () => t.pass('connection on pool'))

  const server = a.createServer({ pool }, (socket) => {
    t.pass('connection on server')
    socket.end()
  })

  await server.listen()

  const open = t.test('open')
  open.plan(2)
  let atLeastOneOpen = false

  {
    const socket = b.connect(server.publicKey)
    socket
      .on('open', () => {
        if (atLeastOneOpen) return

        open.pass('1st stream opened')
        atLeastOneOpen = true
      })
      .on('error', () => {
        open.pass('1st stream errored')
      })
      .end()
  }
  {
    const socket = b.connect(server.publicKey)
    socket
      .on('open', () => {
        if (atLeastOneOpen) return

        open.pass('2nd stream opened')
        atLeastOneOpen = true
      })
      .on('error', () => {
        open.pass('2nd stream errored')
      })
      .end()
  }

  await open
  t.ok(atLeastOneOpen, 'verify one client opened')

  await server.close()
})

test('connection pool, client and server side', async function (t) {
  const [a, b] = await swarm(t)

  const aPool = a.pool()
  aPool.on('connection', () => t.pass('connection on pool a'))

  const bPool = b.pool()
  bPool.on('connection', () => t.pass('connection on pool b'))

  const server = a.createServer({ pool: aPool }, (socket) => {
    t.pass('connection on server')
    socket.end()
  })

  await server.listen()

  const open = t.test('open')
  open.plan(1)

  const socket = b.connect(server.publicKey, { pool: bPool })
  socket
    .on('open', () => {
      open.pass('stream opened')
    })
    .end()

  await open

  await server.close()
})

test('connection pool ignores destroying streams', async function (t) {
  const [a, b] = await swarm(t)

  const server = a.createServer((socket) => {
    socket.on('error', noop).resume()
  })

  await server.listen()

  const pool = b.pool()
  const first = b.connect(server.publicKey, { pool })
  first.on('error', noop)

  await once(first, 'open')

  first.destroy()
  t.ok(first.destroying, 'pooled stream is destroying')

  const second = b.connect(server.publicKey, { pool })
  second.on('error', noop)

  t.is(second === first, false, 'destroying stream is not reused')

  second.destroy()

  await a.destroy()
  await b.destroy()
})

function noop() {}
