import DHT from '../../index.js'

const node = new DHT({
  quickFirewall: false,
  ephemeral: true // just setting this because this is a demo file
})

printInfo()

// Obvs no security implied here!
const serverKeyPair = DHT.keyPair(Buffer.alloc(32).fill('basic-connectivity-server'))

const encryptedSocket = node.connect(serverKeyPair.publicKey, {
  holepunch (remoteNat, localNat, remoteAddress, localAddr) {
    console.log('going to bail punch!', { remoteNat, localNat, remoteAddress, localAddr })
    return false
  }
})

encryptedSocket.on('open', function () {
  console.log('Client connected!')
})

encryptedSocket.on('error', function (err) {
  console.log('Client errored:', err)
})

encryptedSocket.on('close', function () {
  console.log('Client closed...')
})

async function printInfo () {
  await node.ready()

  console.log('DHT node info:')
  console.log('- host: ' + node.host)
  console.log('- port: ' + node.port)
  console.log('- firewalled: ' + node.firewalled)
}
