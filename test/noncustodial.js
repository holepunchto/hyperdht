const test = require('brittle')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const NoiseWrap = require('../lib/noise-wrap')
const { swarm } = require('./helpers')
const DHT = require('../')

test('createServer + connect - external secret key', async (t) => {
  const [a, b] = await swarm(t)

  const lc = t.test('socket lifecycle')
  lc.plan(3)

  const serverKeyPair = DHT.keyPair()

  const server = a.createServer({
    handshake: handshake(serverKeyPair),
    secretStream
  })

  server.on('connection', (socket) => {
    lc.pass('server side opened')

    socket
      .on('data', (data) => lc.alike(data, Buffer.from('hello')))
      .once('end', () => {
        lc.pass('server side ended')
        socket.end()
      })
  })

  // Only pass the public key to the server which will prevent it from
  // announcing itself
  await server.listen({ publicKey: serverKeyPair.publicKey })

  // Manually announce the server to the DHT to make it discoverable
  await a.announce(server.target, serverKeyPair).finished()

  const clientKeyPair = DHT.keyPair()

  const client = b.connect(server.publicKey, {
    handshake: handshake(clientKeyPair),
    secretStream,

    /// Only pass the public key to the client
    keyPair: { publicKey: clientKeyPair.publicKey }
  })

  client.end('hello')

  await lc

  await server.close()
})

// These functions are meant to show how to perform a handshake and setup a
// secret stream without any sensitive data being exposed to the relaying DHT
// node.

function handshake (keyPair) {
  return (_, remotePublicKey) => new class extends NoiseWrap {
    final () {
      const { hash, rx, tx, ...rest } = super.final()

      return {
        ...rest,

        // This is obviously security by obscurity, don't actually do this!
        $secret: { hash, rx, tx }
      }
    }
  }(keyPair, remotePublicKey)
}

function secretStream (isInitiator, rawSocket, opts) {
  if (opts.handshake) {
    const { $secret, ...rest } = opts.handshake
    opts = { ...opts, handshake: { ...rest, ...$secret } }
  }

  return new class extends NoiseSecretStream {
    start (rawSocket, opts) {
      if (opts.handshake) {
        const { $secret, ...rest } = opts.handshake
        opts = { ...opts, handshake: { ...rest, ...$secret } }
      }

      return super.start(rawSocket, opts)
    }
  }(isInitiator, rawSocket, opts)
}
