const test = require('brittle')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const NoiseWrap = require('../lib/noise-wrap')
const Persistent = require('../lib/persistent')
const { swarm } = require('./helpers')
const DHT = require('../')

test('createServer + connect - external secret key', async (t) => {
  const [a, b] = await swarm(t)

  const lc = t.test('socket lifecycle')
  lc.plan(3)

  const serverKeyPair = DHT.keyPair()

  const server = a.createServer({
    createHandshake: createHandshake(serverKeyPair),
    createSecretStream
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

  await server.listen({
    // Only pass the public key to the server
    publicKey: serverKeyPair.publicKey
  }, {
    signAnnounce: signAnnounce(serverKeyPair),
    signUnannounce: signUnannounce(serverKeyPair)
  })

  const clientKeyPair = DHT.keyPair()

  const client = b.connect(server.publicKey, {
    createHandshake: createHandshake(clientKeyPair),
    createSecretStream,

    // Only pass the public key to the client
    keyPair: { publicKey: clientKeyPair.publicKey }
  })

  client.end('hello')

  await lc

  await server.close()
})

// These functions are meant to show how to perform a handshake, setup a
// secret stream, and sign announces/unannounces without any sensitive data
// being exposed to the relaying DHT node.

function createHandshake (keyPair) {
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

function createSecretStream (isInitiator, rawSocket, opts) {
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

function signAnnounce (keyPair) {
  return (target, token, id, data) =>
    Persistent.signAnnounce(target, token, id, data, keyPair.secretKey)
}

function signUnannounce (keyPair) {
  return (target, token, id, data) =>
    Persistent.signUnannounce(target, token, id, data, keyPair.secretKey)
}
