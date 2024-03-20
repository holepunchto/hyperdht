const DHT = require('../../')

const publicKey = Buffer.from(process.argv[2], 'hex')
const secretKey = Buffer.from(process.argv[3], 'hex')
const relayServerPublicKey = Buffer.from(process.argv[4], 'hex')
const keyPair = { publicKey, secretKey }
main()

console.log('publicKey', publicKey.toString('hex'))
console.log('secretKey', secretKey.toString('hex'))
console.log('relayServerPublicKey', relayServerPublicKey.toString('hex'))

async function main () {
  const node = new DHT()
  const server = node.createServer({
    holepunch: false, // To ensure it relies only on relaying
    shareLocalAddress: false, // To help ensure it relies only on relaying (otherwise it can connect directly over LAN, without even trying to holepunch)
    relayThrough: relayServerPublicKey
  }, socket => {
    socket
      .on('open', () => console.log('socket_opened'))
      .on('data', data => {
        console.log(`socket_ondata ${data.toString('hex')}`)
        // client.destroy()
      })
      .on('close', () => console.log('socket_onclose'))
      .on('error', err => console.log(`socket_onerror ${err.code}`))
  })
  server.on('open', () => console.log('server_onopen'))
  server.on('error', err => console.log(`server_onerror ${err.code}`))
  server.on('close', () => console.log('server_onclose'))

  await server.listen(keyPair)
  console.log('started')
}
