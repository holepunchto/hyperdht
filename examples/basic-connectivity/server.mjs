import DHT from '../../index.js'

const node = new DHT({
  ephemeral: true // just setting this because this is a demo file
})

// Just wait for this in the background
printInfo()

// Obvs no security implied here!
const serverKeyPair = DHT.keyPair(Buffer.alloc(32).fill('basic-connectivity-server'))

function firewall (pub, remotePayload, addr) {
  console.log('Should firewall?', pub, remotePayload, addr)
  return false
}

const s = node.createServer({ firewall }, function (connection) {
  console.log('Server got new connection, ending it...')
  connection.write(Buffer.from('Hello world, how are you?'))
  connection.end()
})

await s.listen(serverKeyPair)

console.log('Server is listening...')

process.once('SIGINT', async function () {
  console.log('Closing server...')
  await s.close()
  process.exit(0)
})

async function printInfo () {
  await node.ready()

  console.log('DHT node info:')
  console.log('- host: ' + node.host)
  console.log('- port: ' + node.port)
  console.log('- firewalled: ' + node.firewalled)
}
