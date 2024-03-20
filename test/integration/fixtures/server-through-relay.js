const DHT = require('../../')

const publicKey = Buffer.from(process.argv[2], 'hex')
const secretKey = Buffer.from(process.argv[3], 'hex')
const relayServerPublicKey = Buffer.from(process.argv[4], 'hex')
const bootstrap = JSON.parse(process.argv[5])
const keyPair = { publicKey, secretKey }

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
    setTimeout(() => socket.destroy(), 1000 + 10 * Math.random())
  })
  server.on('open', () => console.log('server_onopen'))
  server.on('error', err => console.log(`server_onerror ${err.code}`))
  server.on('close', () => console.log('server_onclose'))

  await server.listen(keyPair)
  console.log('started')
}
