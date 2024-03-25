const RelayServer = require('blind-relay').Server
const DHT = require('../..')

const dht = new DHT()

const relay = new RelayServer({
  createStream (opts) {
    return dht.createRawStream({ ...opts, framed: true })
  }
})

const server = dht.createServer(function (socket) {
  console.log('Connection from', socket.remotePublicKey.toString('hex'), socket.rawStream.remoteHost)

  const session = relay.accept(socket, { id: socket.remotePublicKey })
  session
    .on('pair', (isInitiator, token, stream, remoteId) => {
      console.log('Pair isInitiator =', isInitiator, 'token =', token.toString('hex'))
    })
})

server
  .listen()
  .then(() => console.log('Relay listening on', server.publicKey.toString('hex')))
