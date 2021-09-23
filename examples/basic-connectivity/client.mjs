import DHT from '../../index.js'
import Client from '../../lib/client.js'

const node = new DHT({
  quickFirewall: false,
  ephemeral: true // just setting this because this is a demo file
})

await node.ready()

console.log('----------- ready -----------')
printInfo()

// Obvs no security implied here!
const serverKeyPair = DHT.keyPair(Buffer.alloc(32).fill('basic-connectivity-server'))
const clientKeyPair = DHT.keyPair(Buffer.alloc(32).fill('basic-connectivity-client'))

const c = new Client(node, serverKeyPair.publicKey, clientKeyPair, {
  holepunch (remoteNat, localNat, remoteAddress, localAddr) {
    console.log('going to bail punch!', { remoteNat, localNat, remoteAddress, localAddr })
    return false
  }
})

const result = c.connect()

result.on('open', function () {
  console.log('Client connected!')
})

async function printInfo () {
  await node.ready()

  console.log('DHT node info:')
  console.log('- host: ' + node.host)
  console.log('- port: ' + node.port)
  console.log('- firewalled: ' + node.firewalled)
}
