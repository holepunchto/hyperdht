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
  const tConns = t.test('connections')
  tConns.plan(4)
  const tOpen1 = t.test('open 1')
  tOpen1.plan(1)
  const tOpen2 = t.test('open 2')
  tOpen2.plan(1)
  const tError1 = t.test('error')
  tError1.plan(1)

  const [a, b] = await swarm(t)

  const pool = a.pool()
  pool.on('connection', () => tConns.pass('connection on pool'))

  const server = a.createServer({ pool }, (conn) => {
    conn.on('error', noop)
    tConns.pass('connection on server')
  })

  await server.listen()

  const socket1 = b.connect(server.publicKey)
  socket1
    .on('open', () => {
      tOpen1.pass('1st stream opened')
    })
    .on('error', (e) => {
      tError1.pass('1st stream errors when 2nd socket opens')
    })

  await tOpen1

  const socket2 = b.connect(server.publicKey)
  socket2
    .on('open', () => {
      tOpen2.pass('2nd stream opened')
    })
    .on('error', () => {
      t.fail('should not error')
    })

  await tOpen2
  await tError1

  socket2.end()

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

function noop() {}

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
  // Reset closing so the next lookup proves the stale route was removed.
  socket.closing = false
  t.absent(routes.get(publicKey), 'closing socket route is removed')

  await node.destroy()
})

test('socket pool replaces closing reusable routes', async function (t) {
  const node = createDHT({ bootstrap: [], ephemeral: true })
  const routes = node._socketPool.routes
  const publicKey = Buffer.alloc(32, 1)

  const closingSocket = new EventEmitter()
  const closingStream = new EventEmitter()
  closingStream.socket = closingSocket

  routes.add(publicKey, closingStream)
  closingSocket.closing = true

  const replacementSocket = new EventEmitter()
  const replacementStream = new EventEmitter()
  replacementStream.socket = replacementSocket

  routes.add(publicKey, replacementStream)
  t.is(routes.get(publicKey).socket, replacementSocket, 'closing route is replaced')

  await node.destroy()
})
