const test = require('brittle')
const { swarm, spawnFixture } = require('../helpers')
const DHT = require('../../')
const path = require('path')
const { Client: KHLClient } = require('keet-hypertrace-logger')

const KEEPALIVE = 5000
const clientKeyPair = DHT.keyPair()
const khlClient = new KHLClient()
khlClient.start({
  createSocket: () => {
    const node = new DHT({
      holepunch: false // To ensure it relies only on relaying
    })
    return node.connect(Buffer.from('17ae5b10a5abdc269e16d740c1eb762f215c05a697c7e37c996abfcc488e82f3', 'hex'), {
      keyPair: clientKeyPair
    })
  },
  getInitialProps: () => ({ alias: 'client' })
})

test.skip('Client connects to Server and keeps reconnectings - with relay', { timeout: 0 }, async t => {
// test.solo('Client connects to Server and keeps reconnectings - with relay', { timeout: 0 }, async t => {
  t.plan(2000)

  const { bootstrap } = await swarm(t)
  const clientNode = new DHT({
    bootstrap,
    // quickFirewall: false, // if uncommented, then "HOLEPUNCH_ABORTED" error is thrown in the client
    ephemeral: true
  })

  t.teardown(async () => {
    await clientNode.destroy()
  })

  const serverKeyPair = DHT.keyPair()
  const serverPublicKey = serverKeyPair.publicKey.toString('hex')
  const serverSecretKey = serverKeyPair.secretKey.toString('hex')
  let closedAt = 0
  let timeoutTookTooLong

  startServer()

  function startServer () {
    t.test('server', async serverTest => {
      serverTest.plan(3)

      const args = [
        path.join(__dirname, 'fixtures/server-through-relay.js'),
        serverPublicKey,
        serverSecretKey,
        JSON.stringify(bootstrap)
      ]

      for await (const [kill, data] of spawnFixture(serverTest, args)) {
        // console.log(`[server] on(data): ${data}`)

        if (data === 'socket_ondata hello') {
          const waitTime = Math.floor(1000 + 1000 * 9 * Math.random())
          serverTest.pass(`Received "hello" from client. Waiting ${waitTime} ms, then killing server`)
          setTimeout(kill, waitTime)
        }

        if (data === 'started') {
          serverTest.pass('Started. Now starting new client')
          startClient()
        }
      }

      serverTest.pass('Server process killed. Waiting for client to detect')
      closedAt = Date.now()

      const waitTimeUntilClientShouldHaveDetected = 4 * KEEPALIVE
      timeoutTookTooLong = setTimeout(() => {
        console.error('THE BUG OCCURED 🥳')
        console.log('Client did not detect that the socket was destroyed in time')
        console.log(`Waited ${waitTimeUntilClientShouldHaveDetected} ms after the server had been killed`)
        process.exit(1)
      }, waitTimeUntilClientShouldHaveDetected)
    })
  }

  function startClient () {
    t.test('client', clientTest => {
      clientTest.plan(2)

      const client = clientNode.connect(serverKeyPair.publicKey, {
        keyPair: clientKeyPair,
        relayThrough: ['45ae429318f146326dddb27168532c7c6b21cacfdd4a43d539e06bd518a7893a', '26eb24c97e53f94d392842b3c0b3fddcb903a0883ac5691e67e4c9d369ef2332', '5c4ee2d0140670b433c0f844fe38264c022842cd9b76b5d28767b462531dfeb2', '8e2a691a6e0b0ede66bd45752b0165514fbec8844721eb038fbcc412af0eb691', '74bd888061f419745bd011367710e0ba98e0db0a2fb12ae1a21ba2d13d75a30c', '1dffaffb7cfe080b15aefae5fa18c2b7ad43facc8882b5d614fd45262f33e9c9', 'f1154be6dcc4f98f38ab4dbfe751457907b14dac3c76d1ed654aa65c690c2968']
      })
      client.setKeepAlive(5000)
      client
        .on('error', err => console.log('[client] error:', err)) // clientTest.is(err.code, 'ETIMEDOUT'))
        .on('open', () => {
          clientTest.pass('Socket opened. Now sending "hello"')
          client.write('hello')
        })
        .on('close', () => {
          const time = Date.now() - closedAt
          clientTest.pass(`Socket closed. Took ${time} ms to detect. Now starting new server`)
          clearTimeout(timeoutTookTooLong)
          startServer()
        })
    })
  }
})
