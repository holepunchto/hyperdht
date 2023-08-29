const DHT = require('../..')

const [relay, server] = process.argv.slice(2)

const dht = new DHT()

const socket = dht.connect(Buffer.from(server, 'hex'), { relayThrough: Buffer.from(relay, 'hex') })
socket.end('Hello!')
