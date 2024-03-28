const test = require('brittle')
const {
  spawnFixture
} = require('../helpers')
const DHT = require('../../')
const path = require('path')
const hic = require('hypercore-id-encoding')
// const { Client: KHLClient } = require('keet-hypertrace-logger')

const KEEPALIVE = 5000
const clientKeyPair = DHT.keyPair()
// const khlClient = new KHLClient()
// khlClient.start({
//   createSocket: () => {
//     const node = new DHT()
//     return node.connect(Buffer.from('17ae5b10a5abdc269e16d740c1eb762f215c05a697c7e37c996abfcc488e82f3', 'hex'), {
//       keyPair: clientKeyPair
//     })
//   },
//   getInitialProps: () => ({ alias: 'client' })
// })

// test.skip('Client connects to Server and keeps reconnectings - with relay', { timeout: 0 }, async t => {
test.solo('Client connects to Server and keeps reconnectings - with relay', { timeout: 0 }, async t => {
  t.plan(10000)

  const clientNode = new DHT()

  t.teardown(async () => {
    await clientNode.destroy()
  })

  const serverKeyPair = DHT.keyPair()
  const serverPublicKey = serverKeyPair.publicKey.toString('hex')
  const serverSecretKey = serverKeyPair.secretKey.toString('hex')
  let closedAt = 0
  let timeoutTookTooLong = null

  startServer()

  function startServer () {
    t.test('server', async serverTest => {
      serverTest.plan(5)

      const args = [
        path.join(__dirname, 'fixtures/server-through-relay.js'),
        serverPublicKey,
        serverSecretKey
      ]

      for await (const [kill, data] of spawnFixture(serverTest, args)) {
        console.log(`[server] output: ${data}`)

        if (data === 'started') {
          console.log('test1')
          serverTest.pass('[1/5] Started. Now starting new client')
          startClient()
        }
        if (data.startsWith('socket_onopen ')) {
          const ip = data.split(' ').pop()
          console.log('test2')
          serverTest.ok(!ip.startsWith('127.'), '[2/5] Not local ip')
          console.log('test3')
          serverTest.ok(!ip.startsWith('10.'), '[3/5] Not local ip')
          console.log(`[server] Connection from ${ip}`)
        }
        if (data === 'socket_ondata hello') {
          const waitTime = Math.floor(1000 + 1000 * 9 * Math.random())
          console.log('test4')
          serverTest.pass(`[4/5] Received "hello" from client. Sending "world" back, then wait ${waitTime} ms and kill server`)
          setTimeout(kill, waitTime)
        }
      }

      console.log('test5')
      serverTest.pass('[5/5] Server process killed. Waiting for client to detect')
      closedAt = Date.now()

      const waitTimeUntilClientShouldHaveDetected = 10 * KEEPALIVE
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
      clientTest.plan(3)

      const client = clientNode.connect(serverKeyPair.publicKey, {
        keyPair: clientKeyPair, // To ensure same client keyPair on each connection
        // relayKeepAlive: 100,
        // relayThrough: [
        //   // hic.decode('8684i4hjjcjqxh6or7kxnidwzqej8z8mi91tuw54k6j548gto7ky')
        //   hic.decode('okyufaztgzc3143c3hmxt35bj63bitnrxtszn4bi36ykn3a1qbqy')
        // ]
        relayThrough: [
          Buffer.from('45ae429318f146326dddb27168532c7c6b21cacfdd4a43d539e06bd518a7893a', 'hex'),
          Buffer.from('26eb24c97e53f94d392842b3c0b3fddcb903a0883ac5691e67e4c9d369ef2332', 'hex'),
          Buffer.from('5c4ee2d0140670b433c0f844fe38264c022842cd9b76b5d28767b462531dfeb2', 'hex'),
          Buffer.from('8e2a691a6e0b0ede66bd45752b0165514fbec8844721eb038fbcc412af0eb691', 'hex'),
          Buffer.from('74bd888061f419745bd011367710e0ba98e0db0a2fb12ae1a21ba2d13d75a30c', 'hex'),
          Buffer.from('1dffaffb7cfe080b15aefae5fa18c2b7ad43facc8882b5d614fd45262f33e9c9', 'hex'),
          Buffer.from('f1154be6dcc4f98f38ab4dbfe751457907b14dac3c76d1ed654aa65c690c2968', 'hex')
        ]
      })
      client.setKeepAlive(KEEPALIVE)
      client
        .on('error', err => console.log('[client] error:', err)) // clientTest.is(err.code, 'ETIMEDOUT'))
        .on('open', () => {
          clientTest.pass('[1/3] Socket opened. Now sending "hello"')
          client.write('hello')
        })
        .on('data', data => {
          data = data.toString()
          if (data === 'world') clientTest.pass('[2/3] Received "world" from server')
        })
        .on('close', () => {
          const time = Date.now() - closedAt
          clientTest.pass(`[3/3] Socket closed. Took ${time} ms to detect. Now starting new server`)
          clearTimeout(timeoutTookTooLong)
          startServer()
        })
    })
  }
})
