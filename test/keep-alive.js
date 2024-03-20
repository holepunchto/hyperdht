const test = require('brittle')
const DHT = require('../')
const { spawn } = require('child_process')
const path = require('path')

// Server is run in a separate proces to make sure that the client doesn't see
// the socket is closed from being run by the same process
test('Client use keepalive to detect disconnect - separated by processes', async t => {
  t.plan(5)

  const keyPair = DHT.keyPair()
  const publicKey = keyPair.publicKey.toString('hex')
  const secretKey = keyPair.secretKey.toString('hex')

  const serverProcess = spawn('node', [path.join(__dirname, 'fixtures/server.js'), publicKey, secretKey])
  serverProcess.stderr.on('data', () => t.fail())
  serverProcess.stdout.on('data', data => {
    data = data.toString().trim()
    const isStarted = data === 'started'
    const isSocketConnected = data === 'socket_connected'
    if (isStarted) {
      t.pass('Server started. Now starting client')
      startClient()
    }
    if (isSocketConnected) {
      t.pass('Client connected. Killing server process in 1 second')
      setTimeout(() => serverProcess.kill('SIGKILL'), 1000) // Wait a bit to make sure the handshake has happened
    }
  })

  function startClient () {
    const node = new DHT()
    const clientSocket = node.connect(publicKey)
    clientSocket.setKeepAlive(5000)
    clientSocket.on('open', () => t.pass('Client connected'))
    clientSocket.on('error', err => t.is(err.code, 'ETIMEDOUT'))
    clientSocket.on('close', () => {
      t.pass('Client discovered that the connection has been lost')
      node.destroy()
    })
  }
})

test('Client not using keepalive does not detect disconnect - separated by processes', async t => {
  t.plan(4)

  const keyPair = DHT.keyPair()
  const publicKey = keyPair.publicKey.toString('hex')
  const secretKey = keyPair.secretKey.toString('hex')

  const serverProcess = spawn('node', [path.join(__dirname, 'fixtures/server.js'), publicKey, secretKey])
  serverProcess.stderr.on('data', () => t.fail())
  serverProcess.stdout.on('data', data => {
    data = data.toString().trim()
    const isStarted = data === 'started'
    const isSocketConnected = data === 'socket_connected'
    if (isStarted) {
      t.pass('Server started. Now starting client')
      startClient()
    }
    if (isSocketConnected) {
      t.pass('Client connected. Killing server process in 1 second')
      setTimeout(() => serverProcess.kill('SIGKILL'), 1000) // Wait a bit to make sure the handshake has happened
      setTimeout(() => {
        timedout = true

        t.pass('After 20 seconds the connection was still open. Closing it now')
        node.destroy()
      }, 24000)
    }
  })

  let timedout = false
  const node = new DHT()

  function startClient () {
    const clientSocket = node.connect(publicKey)
    clientSocket.on('open', () => t.pass('Client connected'))
    clientSocket.on('error', () => !timedout && t.fail())
    clientSocket.on('close', () => !timedout && t.fail())
  }
})
