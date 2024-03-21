const test = require('brittle')
const RelayServer = require('blind-relay').Server
const { swarm, spawnFixture } = require('../helpers')
const DHT = require('../../')
const path = require('path')
const { Client: KHLClient } = require('keet-hypertrace-logger')

const clientKeyPair = DHT.keyPair()
const khlClient = new KHLClient()
khlClient.start({
  createSocket: () => {
    const node = new DHT()
    return node.connect(Buffer.from('17ae5b10a5abdc269e16d740c1eb762f215c05a697c7e37c996abfcc488e82f3', 'hex'), {
      keyPair: clientKeyPair
    })
  },
  getInitialProps: () => ({ alias: 'client' })
})

test.skip('Client connects to Server and keeps reconnectings - with relay', { timeout: 0 }, async t => {
// test.solo('Client connects to Server and keeps reconnectings - with relay', { timeout: 0 }, async t => {
  t.plan(20)

  const { bootstrap } = await swarm(t)
  const relayNode = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const clientNode = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  t.teardown(async () => {
    await relayNode.destroy()
    await clientNode.destroy()
    relay.close()
  })

  const relay = new RelayServer({
    createStream (opts) {
      return relayNode.createRawStream({ ...opts, framed: true })
    }
  })

  const relayServer = relayNode.createServer(socket => {
    const relaySession = relay.accept(socket, { id: socket.remotePublicKey })
    relaySession.on('error', (err) => t.fail(err))
  })

  await relayServer.listen()

  const serverKeyPair = DHT.keyPair()
  const serverPublicKey = serverKeyPair.publicKey.toString('hex')
  const serverSecretKey = serverKeyPair.secretKey.toString('hex')
  const relayServerPublicKey = relayServer.publicKey.toString('hex')

  startServer()

  function startServer () {
    t.test('server', async serverTest => {
      serverTest.plan(3)

      const args = [
        path.join(__dirname, 'fixtures/server-through-relay.js'),
        serverPublicKey,
        serverSecretKey,
        relayServerPublicKey,
        JSON.stringify(bootstrap)
      ]

      for await (const [kill, data] of spawnFixture(serverTest, args)) {
        if (data === 'started') {
          serverTest.pass('Started. Now starting new client')
          startClient()
        }

        if (data === 'socket_onopen') {
          serverTest.pass('Socket connected. Waiting 1..10 seconds, then killing server')
          setTimeout(kill, 1000 + 1000 * 10 * Math.random())
        }
      }

      serverTest.pass('Process died')
    })
  }

  function startClient () {
    t.test('client', clientTest => {
      clientTest.plan(3)

      const client = clientNode.connect(serverKeyPair.publicKey, {
        keyPair: clientKeyPair,
        relayThrough: relayServer.publicKey
      })
      client.setKeepAlive(5000)
      client
        .on('error', err => clientTest.is(err.code, 'ETIMEDOUT'))
        .on('open', () => clientTest.pass('Socket opened'))
        .on('close', () => {
          clientTest.pass('Socket closed. Now starting new server')
          startServer()
        })
    })
  }
})
