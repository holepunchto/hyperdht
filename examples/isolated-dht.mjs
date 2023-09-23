import DHT from '../index.js'

// [BOOTSTRAP NODE]
// Let's say you created a VPS and it has a public IP, you would use it here:
const MY_PUBLIC_IP = '127.0.0.1' // If it's for a local network then use the corresponding local address like 192.168.0.15

// Inside that server, to create our first bootstrap node:
const bootstrap1 = DHT.bootstrapper(49737, MY_PUBLIC_IP)
await bootstrap1.ready()
// Your bootstrap node is now running at 67.205.140.151:49737 and it's globally accessible for anyone to use it.

// CLI equivalent for creating the first bootstrap node:
// hyperdht --bootstrap --host 127.0.0.1 --port 49737

// This would be the list of bootstrap nodes:
const bootstrap = [{ host: MY_PUBLIC_IP, port: bootstrap1.address().port }]
// You can achieve redundancy by having 2-3 servers with the same setup above in each server.

// [THREE IMPORTANT CONCEPTS]
// By default, all nodes joining a DHT network are considered ephemeral nodes.

// What is "ephemeral"?
// 1) Low uptime (less than ~30 mins online).
// 2) It may or not be firewalled.

// Nodes adapt themselves. After a good time they can automatically become persistent nodes.

// What is "persistent"?
// 1) High uptime (at least ~30 mins online).
// 2) It's not firewalled (ports are not blocked).
// Example: a node in your home computer may never be adapted to "persistent" as you're probably behind a firewall.
// Persistent nodes are a bit special as they join other nodes routing table, so they need to be accessible (no firewall).

// What is a "bootstrap node"?
// 1) You know the ip:port (i.e. static IP or DNS).
// 2) It's not firewalled.
// 3) It's always running, it has to be online for new nodes to join. Unless peers know any other persistent nodes.

// [USAGE]
// Now is time to use the network as a normal user!
const node1 = new DHT({ bootstrap })
const node2 = new DHT({ bootstrap })

await node1.ready()
await node2.ready()

const server = node1.createServer(function (socket) {
  console.log('server connection')
  // ...
})
await server.listen()

const socket = node2.connect(server.publicKey)
socket.once('open', function () {
  console.log('socket open')
})
// ...
