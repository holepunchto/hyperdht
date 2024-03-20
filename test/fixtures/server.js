const DHT = require('../../')

main()

async function main () {
  const publicKey = Buffer.from(process.argv[2], 'hex')
  const secretKey = Buffer.from(process.argv[3], 'hex')
  const keyPair = { publicKey, secretKey }

  const node = new DHT()
  const server = node.createServer(socket => {
    console.log('socket_connected')
  })

  await server.listen(keyPair)
  console.log('started')
}
