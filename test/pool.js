const test = require('brittle')
const { EventEmitter } = require('events')
const { swarm, createDHT } = require('./helpers')

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

test('socket pool ignores closing reusable routes', async function (t) {
  const node = createDHT({ bootstrap: [], ephemeral: true })
  const routes = node._socketPool.routes
  const publicKey = Buffer.alloc(32, 1)

  const socket = new EventEmitter()

  const rawStream = new EventEmitter()
  rawStream.socket = socket

  routes.add(publicKey, rawStream)
  t.ok(routes.get(publicKey), 'route is registered')

  socket.closing = true
  t.absent(routes.get(publicKey), 'closing socket route is ignored')
  socket.closing = false
  t.absent(routes.get(publicKey), 'closing socket route is removed')

  await node.destroy()
})
