const test = require('brittle')
const DHT = require('../')
const { spawn } = require('child_process')

// Server is run in a separate proces to make sure that the client doesn't see
// the socket is closed from being run by the same process
test.solo('Client use keep-alive to detect disconnect - separated by processes', async t => {
  t.plan(4)

  const keyPair = DHT.keyPair()
  const publicKey = keyPair.publicKey.toString('hex')
  const secretKey = keyPair.secretKey.toString('hex')

  const serverProcess = spawn('node', ['test/fixtures/server.js', publicKey, secretKey])
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
      t.pass('Cliet connected. Killing server process')
      serverProcess.kill()
    }
  })

  function startClient () {
    const node = new DHT()
    const clientSocket = node.connect(publicKey)
    clientSocket.setKeepAlive(5000)
    clientSocket.on('open', () => t.pass('Client connected'))
    clientSocket.on('error', err => console.log('here be error', err))
    clientSocket.on('close', () => () => {
      console.log('on close')
      t.pass('Client discovered disconnect')
    })
  }
})
