const DHT = require('../..')

const dht = new DHT()

const server = dht.createServer((socket) => {
  console.log('Connection from', socket.remotePublicKey.toString('hex'))
  socket
    .on('data', (data) => console.log(data.toString()))
    .end()
})

server
  .listen()
  .then(() => console.log('Server listening on', server.publicKey.toString('hex')))
