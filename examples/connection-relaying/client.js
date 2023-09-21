const DHT = require('../..')

const [relay, server] = process.argv.slice(2)

const dht = new DHT()

const socket = dht.connect(Buffer.from(server, 'hex'), {
  localConnection: false,
  relayThrough: Buffer.from(relay, 'hex')
})

console.log('Client connecting from', socket.publicKey.toString('hex'))

socket.end('Hello!')
