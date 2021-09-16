import DHT from '../../index.js'

const node = new DHT({
  ephemeral: true // just setting this because this is a demo file
})

printInfo()

// Obvs no security implied here!
const serverKeyPair = DHT.keyPair(Buffer.alloc(32).fill('basic-connectivity-server'))

const s = node.createServer(function (connection) {
  console.log('Server got new connection, ending it...')
  connection.end()
})

await s.listen(serverKeyPair)

console.log('Server is listening...')

async function printInfo () {
  await node.ready()

  console.log('DHT node info:')
  console.log('- host: ' + node.host)
  console.log('- port: ' + node.port)
  console.log('- firewalled: ' + node.firewalled)
}
