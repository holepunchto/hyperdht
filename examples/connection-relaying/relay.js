const RelayServer = require('protomux-bridging-relay').Server
const DHT = require('../..')

const dht = new DHT()

const relay = new RelayServer({
  createStream (opts) {
    return dht.createRawStream({ ...opts, framed: true })
  }
})

const server = dht.createServer({ connectionRelay: true }, (socket) => {
  console.log('Connection from', socket.remotePublicKey.toString('hex'))
  relay.accept(socket, { id: socket.remotePublicKey })
})

server
  .listen()
  .then(() => console.log('Relay listening on', server.publicKey.toString('hex')))
