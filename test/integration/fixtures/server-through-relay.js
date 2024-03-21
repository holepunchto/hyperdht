const DHT = require('../../../')
const { Client: KHLClient } = require('keet-hypertrace-logger')

const publicKey = Buffer.from(process.argv[2], 'hex')
const secretKey = Buffer.from(process.argv[3], 'hex')
const relayServerPublicKey = Buffer.from(process.argv[4], 'hex')
const bootstrap = JSON.parse(process.argv[5])
const keyPair = { publicKey, secretKey }
const khlClient = new KHLClient()
khlClient.start({
  createSocket: () => {
    const node = new DHT()
    return node.connect(Buffer.from('17ae5b10a5abdc269e16d740c1eb762f215c05a697c7e37c996abfcc488e82f3', 'hex'), {
      keyPair
    })
  },
  getInitialProps: () => ({ alias: 'server' })
})

main()

async function main () {
  const node = new DHT({ bootstrap })
  const server = node.createServer({
    holepunch: false, // To ensure it relies only on relaying
    shareLocalAddress: false, // To help ensure it relies only on relaying (otherwise it can connect directly over LAN, without even trying to holepunch)
    relayThrough: relayServerPublicKey
  }, socket => {
    socket.setKeepAlive(5000)
    socket
      .on('open', () => console.log('socket_onopen'))
      .on('close', () => console.log('socket_onclose'))
      .on('error', err => console.log(`socket_onerror ${err.code}`))
  })
  server.on('open', () => console.log('server_onopen'))
  server.on('error', err => console.log(`server_onerror ${err.code}`))
  server.on('close', () => console.log('server_onclose'))

  await server.listen(keyPair)
  console.log('started')
}
