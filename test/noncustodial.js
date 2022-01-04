const test = require('brittle')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { swarm } = require('./helpers')
const DHT = require('../')
const NoiseWrap = require('../lib/noise-wrap')

const keyPair = DHT.keyPair()

test('createServer() with externally managed secret key', async (t) => {
  const [a, b] = await swarm(t)

  const lc = t.test('socket lifecycle')
  lc.plan(3)

  const handshake = new NoiseWrap(keyPair, null)

  const server = a.createServer({
    handshake: () => {
      return {
        send (payload) {
          return handshake.send(payload)
        },
        recv (buffer) {
          return handshake.recv(buffer)
        },
        final () {
          return {
            ...handshake.final(),

            // Remove the Noise keys as these are kept secret
            hash: null,
            rx: null,
            tx: null
          }
        }
      }
    }
  })

  server.on('rawConnection', (rawSocket, data, ended) => {
    lc.pass('server side opened')

    const socket = new NoiseSecretStream(false, rawSocket, {
      handshake: handshake.final(),
      data,
      ended
    })

    socket
      .on('data', (data) => lc.alike(data, Buffer.from('hello')))
      .once('end', () => {
        lc.pass('server side ended')
        socket.end()
      })
  })

  // Only pass the public key to the server which will prevent it from
  // announcing itself
  await server.listen({ publicKey: keyPair.publicKey })

  // Manually announce the server to the DHT to make it discoverable
  await a.announce(server.target, keyPair).finished()

  b.connect(server.publicKey).end('hello')

  await lc

  await server.close()
})
