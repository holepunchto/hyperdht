const test = require('brittle')
const DHT = require('../../')
const path = require('path')
const { swarm, spawnFixture } = require('../helpers')
const b4a = require('b4a')

// Server is run in a separate proces to make sure that we can forcefully close it.
// If the server called `socket.destroy()` that would send an unacked packet back
// to the client and it would notice that the socket has been closed - and thus the
// keepalive timeout would never kick in.

test('Client use keepalive to detect disconnect - separated by processes', async t => {
  t.plan(2)
  t.teardown(() => node.destroy())

  const clientTest = t.test('client')
  const { bootstrap } = await swarm(t)
  const node = new DHT({ bootstrap })
  const keyPair = DHT.keyPair()
  const publicKey = b4a.toString(keyPair.publicKey, 'hex')
  const secretKey = b4a.toString(keyPair.secretKey, 'hex')

  clientTest.plan(3)

  t.test('server', async serverTest => {
    serverTest.plan(3)

    const args = [
      path.join(__dirname, 'fixtures/server.js'),
      publicKey,
      secretKey,
      JSON.stringify(bootstrap)
    ]

    for await (const [kill, data] of spawnFixture(serverTest, args)) {
      if (data === 'started') {
        serverTest.pass('Started. Now starting client')
        startClient()
      }

      if (data === 'socket_connected') {
        serverTest.pass('Client connected. Killing server process in 1 second')
        kill()
      }
    }

    serverTest.pass('Process died')
  })

  function startClient () {
    const clientSocket = node.connect(publicKey)
    clientSocket.setKeepAlive(100)
    clientSocket.on('open', () => clientTest.pass('Connected'))
    clientSocket.on('error', err => clientTest.is(err.code, 'ETIMEDOUT'))
    clientSocket.on('close', () => clientTest.pass('Discovered that the connection has been lost'))
  }
})

test('Client not using keepalive does not detect disconnect - separated by processes', async t => {
  t.plan(2)
  t.teardown(() => node.destroy())

  const clientTest = t.test('client')
  const { bootstrap } = await swarm(t)
  const node = new DHT({ bootstrap, connectionKeepAlive: false })
  const keyPair = DHT.keyPair()
  const publicKey = b4a.toString(keyPair.publicKey, 'hex')
  const secretKey = b4a.toString(keyPair.secretKey, 'hex')
  let timedout = false

  clientTest.plan(2)

  t.test('server', async serverTest => {
    serverTest.plan(3)

    const args = [
      path.join(__dirname, 'fixtures/server.js'),
      publicKey,
      secretKey,
      JSON.stringify(bootstrap)
    ]

    for await (const [kill, data] of spawnFixture(serverTest, args)) {
      if (data === 'started') {
        serverTest.pass('Started. Now starting client')
        startClient()
      }

      if (data === 'socket_connected') {
        serverTest.pass('Client connected. Killing server process in 1 second')
        kill()
      }
    }

    serverTest.pass('Process died')

    setTimeout(() => {
      timedout = true
      clientTest.pass('After 20 seconds the connection is still open')
    }, 20000)
  })

  function startClient () {
    const clientSocket = node.connect(publicKey)
    // No .setKeepAlive() here
    clientSocket.on('open', () => clientTest.pass('Connected'))
    clientSocket.on('error', () => !timedout && clientTest.fail())
    clientSocket.on('close', () => !timedout && clientTest.fail())
  }
})
