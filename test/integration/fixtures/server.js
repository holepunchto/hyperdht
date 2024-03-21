const DHT = require('../../../')

main()

async function main () {
  const publicKey = Buffer.from(process.argv[2], 'hex')
  const secretKey = Buffer.from(process.argv[3], 'hex')
  const bootstrap = JSON.parse(process.argv[4])
  const keyPair = { publicKey, secretKey }

  const node = new DHT({ bootstrap })
  const server = node.createServer(socket => {
    console.log('socket_connected')
  })

  await server.listen(keyPair)
  console.log('started')
}
