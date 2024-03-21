const test = require('brittle')
const DHT = require('../../')
const { spawn } = require('child_process')
const path = require('path')
const NewlineDecoder = require('newline-decoder')
const { swarm } = require('../helpers')

// Server is run in a separate proces to make sure that we can forcefully close it.
// If the server called `socket.destroy()` that would send an unacked packet back
// to the client and it would notice that the socket has been closed - and thus the
// keepalive timeout would never kick in.

async function * spawnFixture (t, args) {
  const proc = spawn(process.execPath, args)
  const nl = new NewlineDecoder()

  proc.stderr.on('data', err => t.fail(err))
  const kill = () => setTimeout(() => proc.kill('SIGKILL'), 1000)

  for await (const data of proc.stdout) {
    for (const line of nl.push(data)) yield [kill, line]
  }

  t.pass('died')
}

test('Client use keepalive to detect disconnect - separated by processes', async t => {
  t.plan(2)
  t.teardown(() => node.destroy())

  const clientTest = t.test('client')

  clientTest.plan(3)

  const { bootstrap } = await swarm(t)
  const node = new DHT({ bootstrap })
  const keyPair = DHT.keyPair()
  const publicKey = keyPair.publicKey.toString('hex')
  const secretKey = keyPair.secretKey.toString('hex')

  t.test('server', async function (serverTest) {
    for await (const [kill, data] of spawnFixture(serverTest, [path.join(__dirname, 'fixtures/server.js'), publicKey, secretKey, JSON.stringify(bootstrap)])) {
      if (data === 'started') {
        serverTest.pass('Started. Now starting client')
        startClient()
      }

      if (data === 'socket_connected') {
        serverTest.pass('Client connected. Killing server process in 1 second')
        kill()
      }
    }
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
  t.plan(4)
  t.teardown(() => node.destroy())

  const { bootstrap } = await swarm(t)
  const node = new DHT({ bootstrap })
  const keyPair = DHT.keyPair()
  const publicKey = keyPair.publicKey.toString('hex')
  const secretKey = keyPair.secretKey.toString('hex')
  let timedout = false
  const serverProcess = spawn(process.execPath, [
    path.join(__dirname, 'fixtures/server.js'),
    publicKey,
    secretKey,
    JSON.stringify(bootstrap)
  ])

  serverProcess.stderr.on('data', () => t.fail())
  serverProcess.stdout.on('data', data => {
    data = data.toString().trim()
    const isStarted = data === 'started'
    const isSocketConnected = data === 'socket_connected'
    if (isStarted) {
      t.pass('[server] Started. Now starting client')
      startClient()
    }
    if (isSocketConnected) {
      t.pass('[server] Client connected. Killing server process in 1 second')
      setTimeout(() => serverProcess.kill('SIGKILL'), 1000) // Wait a bit to make sure the handshake has happened
      setTimeout(() => {
        timedout = true

        t.pass('After 20 seconds the connection is still open')
      }, 20000)
    }
  })

  function startClient () {
    const clientSocket = node.connect(publicKey)
    // No .setKeepAlive() here
    clientSocket.on('open', () => t.pass('[client] Connected'))
    clientSocket.on('error', () => !timedout && t.fail())
    clientSocket.on('close', () => !timedout && t.fail())
  }
})
