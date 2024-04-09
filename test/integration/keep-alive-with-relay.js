const test = require('brittle')
const { spawnFixture } = require('../helpers')
const { Server: RelayServer } = require('blind-relay')
const DHT = require('../../')
const path = require('path')
const b4a = require('b4a')

/*
  When a peer connects to a relay server, there's two sockets established. One for data (between two peers)
  and another "control" socket.
  The relay server has a RELAY_KEEPALIVE that looks at the control socket to detect when a peer is no longer there.
  The client and server both have a SOCKET_KEEPALIVE which detects when the other peer is no longer there.

  A bug that occured with udx-native < 1.8.9 is that the relay server had detected the control socket had bad been destroyed,
  but didn't fully clean up internally. That meant that this information was never fully relayed to the other peer.
*/
test('When Server is killed, Client should detect this - through relay', async t => {
  t.plan(3)

  const relayTest = t.test('relay')
  relayTest.plan(3)
  const clientTest = t.test('client')
  clientTest.plan(3)
  const serverTest = t.test('server')
  serverTest.plan(3)

  const RELAY_KEEPALIVE = 500
  const SOCKET_KEEPALIVE = 10 * RELAY_KEEPALIVE

  const clientKeyPair = DHT.keyPair()
  const clientNode = new DHT()
  const relayNode = new DHT()
  const relayKeyPair = DHT.keyPair()
  const serverKeyPair = DHT.keyPair()
  const serverPublicKey = b4a.toString(serverKeyPair.publicKey, 'hex')
  const serverSecretKey = b4a.toString(serverKeyPair.secretKey, 'hex')
  let hasClientDetectedThatServerDied = false
  let didClientNotDetectThatServerDiedTimer
  let didClientNotDetectThatServerDiedTimerFired = false

  t.teardown(async () => {
    await clientNode.destroy()
    await relayNode.destroy()
  })

  await startRelayServer()
  await startServer()

  async function startRelayServer () {
    const relay = new RelayServer({
      createStream (opts) {
        return relayNode.createRawStream({ ...opts, framed: true })
      }
    })

    const relayServer = relayNode.createServer(socket => {
      relayTest.pass('Socket connected')
      socket.setKeepAlive(RELAY_KEEPALIVE)

      socket.on('error', err => {
        // when error is ETIMEDOUT it's the server connection that has broken
        // not so long after that, the client should have detected that the connection is gone
        if (err.code === 'ETIMEDOUT') {
          relayTest.pass('Relay server detected that server has died. Waiting for client to detect')

          // In some cases, the client may have detected that the server has died before the relay server
          if (hasClientDetectedThatServerDied) return

          const timeToDetectClientHasDied = SOCKET_KEEPALIVE
          didClientNotDetectThatServerDiedTimer = setTimeout(() => {
            didClientNotDetectThatServerDiedTimerFired = true
            clientTest.fail('Client did not detect that the server has died')
          }, timeToDetectClientHasDied)
        }
      })

      const session = relay.accept(socket, { id: socket.remotePublicKey })
      session.on('error', () => { })
    })

    await relayServer.listen(relayKeyPair)
  }

  async function startServer () {
    const args = [
      path.join(__dirname, 'fixtures/server-through-relay.js'),
      serverPublicKey,
      serverSecretKey,
      b4a.toString(relayKeyPair.publicKey, 'hex'),
      SOCKET_KEEPALIVE,
      RELAY_KEEPALIVE
    ]

    for await (const [kill, data] of spawnFixture(serverTest, args)) {
      if (data === 'started') {
        serverTest.pass('Started. Now starting new client')
        startClient()
      }
      if (data === 'socket_ondata hello') {
        serverTest.pass('Received "hello" from client. Sending "world" back, then wait 1 second and kill server')
        setTimeout(kill, 1000)
      }
    }

    serverTest.pass('Server process killed. Waiting for relay server to detect')
  }

  function startClient () {
    const client = clientNode.connect(serverKeyPair.publicKey, {
      keyPair: clientKeyPair, // To ensure same client keyPair on each connection
      relayKeepAlive: RELAY_KEEPALIVE,
      relayThrough: relayKeyPair.publicKey
    })
    client.setKeepAlive(SOCKET_KEEPALIVE)
    // If the client does not receive a ETIMEDOUT it's because it has not detected
    // that the server has been killed. Important to note that all of this is through
    // the relay server. Essentially it's whether or not the relay server
    // detected that the server had been killed and relayed that information downstream
    // to the client
    client
      .on('error', () => { })
      .on('open', () => {
        clientTest.pass('Socket opened. Now sending "hello"')
        client.write('hello')
      })
      .on('data', data => {
        data = data.toString()

        if (data === 'world') {
          clientTest.pass('Received "world" from server')
        }
      })
      .on('close', () => {
        if (didClientNotDetectThatServerDiedTimerFired) return // If this has fired, then it's too late

        hasClientDetectedThatServerDied = true
        clearTimeout(didClientNotDetectThatServerDiedTimer)
        clientTest.pass('Client correctly detected that server had died')
      })
  }
})
