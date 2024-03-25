const DHT = require('../..')

const dht = new DHT()
const relay = process.argv[2]

const server = dht.createServer({
  holepunch: false, // To ensure it relies only on relaying
  shareLocalAddress: false, // To help ensure it relies only on relaying (otherwise it can connect directly over LAN, without even trying to holepunch)
  relayThrough: Buffer.from(relay, 'hex')
}, (socket) => {
  console.log('Connection from', socket.remotePublicKey.toString('hex'), socket.rawStream.remoteHost)
  socket
    .on('data', (data) => console.log(data.toString()))
    .end()
})

server
  .listen()
  .then(() => console.log('Server listening on', server.publicKey.toString('hex')))
