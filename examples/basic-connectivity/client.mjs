import DHT from '../../index.js'

const node = new DHT({
  ephemeral: true // just setting this because this is a demo file
})

// Just wait for this in the background
printInfo()

// Obvs no security implied here!
const serverKeyPair = DHT.keyPair(Buffer.alloc(32).fill('basic-connectivity-server'))

const encryptedSocket = node.connect(serverKeyPair.publicKey)

encryptedSocket.on('open', function () {
  console.log('Client connected!')
})

encryptedSocket.on('error', function (err) {
  console.log('Client errored:', err)
})

encryptedSocket.on('close', function () {
  console.log('Client closed...')
})

encryptedSocket.on('data', function (data) {
  console.log('Client got data:', data.toString())
})

encryptedSocket.on('end', function () {
  console.log('Client ended...')
  encryptedSocket.end()
})

async function printInfo () {
  await node.ready()

  console.log('DHT node info:')
  console.log('- host: ' + node.host)
  console.log('- port: ' + node.port)
  console.log('- firewalled: ' + node.firewalled)
}
