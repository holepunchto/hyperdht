const DHT = require('../..')

const [relay, server] = process.argv.slice(2)

const dht = new DHT()

const socket = dht.connect(Buffer.from(server, 'hex'), {
  fastOpen: false,
  localConnection: false,
  relayThrough: Buffer.from(relay, 'hex'),
  holepunch () {
    return false
  }
})

console.log('Client connecting from', socket.publicKey.toString('hex'))

socket.end('Hello!')
