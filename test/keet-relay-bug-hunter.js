const test = require('brittle')
const RelayServer = require('blind-relay').Server
const { swarm } = require('./helpers')
const DHT = require('../')
const { spawn } = require('child_process')
const path = require('path')

// server.set keep-alive
// server.on(connection, () => wait 1..10 sec, then close connection)
// client.set keep-alive
// client - should reconnect when connection dies

test.solo('Client connects to Server and keeps reconnectings - with relay', async t => {
  const { bootstrap } = await swarm(t)

  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  t.plan(5)
  t.teardown(async () => {
    console.log('teardown time')
    await a.destroy()
    await c.destroy()
    await b.destroy()
    relay.close()
  })

  const relay = new RelayServer({
    createStream (opts) {
      console.log('[relay] createStream()')
      return a.createRawStream({ ...opts, framed: true })
    }
  })

  const relayServer = a.createServer(function (socket) {
    console.log('[relayServer] Got connection')
    const relaySession = relay.accept(socket, { id: socket.remotePublicKey })
    // const isClient = socket.remotePublicKey.toString('hex') === client.publicKey.toString('hex')
    // const isServer = socket.remotePublicKey.toString('hex') === server.publicKey.toString('hex')
    relaySession.on('pair', (isInitiator) => {
      // console.log(`[relayServer] on(pair) isInitiator=${isInitiator} from=${isClient ? 'client' : isServer ? 'server' : 'ERROR'}`)
      console.log(`[relayServer] on(pair) isInitiator=${isInitiator}`)
      if (isInitiator) {
        // testRelayInitiator.pass('The initiator paired with the relay server')
      } else {
        // testRelayFollower.pass('The non-iniator paired with the relay server')
      }
    })
    relaySession.on('error', (err) => t.comment(err.message))
  })

  await relayServer.listen()

  const serverKeyPair = DHT.keyPair()
  const serverPublicKey = serverKeyPair.publicKey.toString('hex')
  const serverSecretKey = serverKeyPair.secretKey.toString('hex')
  const relayServerPublicKey = relayServer.publicKey.toString('hex')

  startServer()

  function startServer () {
    const serverProcess = spawn('node', [path.join(__dirname, 'fixtures/server-through-relay.js'), serverPublicKey, serverSecretKey, relayServerPublicKey])
    serverProcess.stderr.on('data', () => t.fail())
    serverProcess.stdout.on('data', data => {
      data = data.toString().trim()
      console.log(`[serverProcess] ${data}`)
      const isStarted = data === 'started'
      const isSocketConnected = data === 'socket_connected'
      if (isStarted) {
        t.pass('Server started. Now starting client')
        setTimeout(() => startClient(), 1000)
      }
      if (isSocketConnected) {
        t.pass('Client connected. Killing server process in 1 second')
        // setTimeout(() => serverProcess.kill('SIGKILL'), 1000) // Wait a bit to make sure the handshake has happened
        // setTimeout(() => {
        //   timedout = true

        //   t.pass('After 20 seconds the connection was still open. Closing it now')
        //   node.destroy()
        // }, 24000)
      }
    })
    serverProcess.on('close', () => console.log('[serverProcess] on(close)'))
    serverProcess.on('exit', () => console.log('[serverProcess] on(exit)'))
  }

  // const server = b.createServer({
  //   holepunch: false, // To ensure it relies only on relaying
  //   shareLocalAddress: false, // To help ensure it relies only on relaying (otherwise it can connect directly over LAN, without even trying to holepunch)
  //   relayThrough: relayServer.publicKey
  // }, function (socket) {
  //   t.pass('server socket opened')
  //   socket
  //     .on('data', async (data) => {
  //       t.alike(data, Buffer.from('hello world'))
  //       client.destroy()
  //     })
  //     .on('close', () => {
  //       t.pass('server socket closed')
  //     })
  //     .on('error', err => t.comment('server error', err))
  // })

  // await server.listen()

  function startClient () {
    console.log('[startClient()] serverKeyPair.publicKey', serverKeyPair.publicKey.toString('hex'))
    console.log('[startClient()] relayServer.publicKey', relayServer.publicKey.toString('hex'))
    const client = c.connect(serverKeyPair.publicKey, { relayThrough: relayServer.publicKey })
    client
      .on('open', () => {
        t.pass('client socket opened')
        client.write('hello world')
      })
      .on('close', () => {
        t.pass('client socket closed')
      })
      .on('error', err => console.error('client error', err))
  }
})
