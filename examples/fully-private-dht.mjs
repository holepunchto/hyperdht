import DHT from '../index.js'

const bootstrap1 = new DHT({ bootstrap: [], port: 49737, anyPort: false, ephemeral: false, firewalled: false })
// const bootstrap1 = DHT.bootstrapper(49737) // TODO: use bootstrapper
await bootstrap1.ready()

const bootstrap = [bootstrap1.address()]
const node1 = new DHT({ bootstrap, ephemeral: false }) // TODO: remove {ephemeral:false}
const node2 = new DHT({ bootstrap })

await node1.ready()
await node2.ready()

const server = node1.createServer(function (socket) {
  // ...
})
await server.listen()

const socket = node2.connect(server.publicKey)
socket.once('open', function () {
  console.log('socket open')
})
// ...
