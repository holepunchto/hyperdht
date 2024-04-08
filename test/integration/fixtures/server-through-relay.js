const DHT = require('../../../')

const publicKey = Buffer.from(process.argv[2], 'hex')
const secretKey = Buffer.from(process.argv[3], 'hex')
const relayServer = Buffer.from(process.argv[4], 'hex')
const socketKeepAlive = Number(process.argv[5] || 5000)
const relayKeepAlive = Number(process.argv[6] || 5000)
const keyPair = { publicKey, secretKey }

main()

async function main () {
  const node = new DHT()
  const server = node.createServer({
    holepunch: false, // To ensure it relies only on relaying
    shareLocalAddress: false, // To help ensure it relies only on relaying (otherwise it can connect directly over LAN, without even trying to holepunch)
    relayKeepAlive,
    relayThrough: relayServer
  }, socket => {
    socket.setKeepAlive(socketKeepAlive)
    socket
      .on('data', data => {
        console.log(`socket_ondata ${data.toString()}`)
        socket.write('world')
      })
      .on('open', () => console.log(`socket_onopen ${socket.rawStream.remoteHost}:${socket.rawStream.remotePort}`))
      .on('close', () => console.log('socket_onclose'))
      .on('error', err => console.log(`socket_onerror ${err.code}`))
  })
  server.on('open', () => console.log('server_onopen'))
  server.on('error', err => console.log(`server_onerror ${err.code}`))
  server.on('close', () => console.log('server_onclose'))
  console.log('prelistening')
  await server.listen(keyPair)
  console.log('postlistening')
  console.log('started')
}
