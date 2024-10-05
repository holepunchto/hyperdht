import DHT from '../index.js'

// [PART 1]
// Let's say I used DigitalOcean to create a server and it has a public IP:
const MY_PUBLIC_IP = '67.205.140.151' // If you're on a local machine then use '127.0.0.1' or the corresponding internal address

// Inside that server, to create our first bootstrap node:
const bootstrap1 = DHT.bootstrapper(49737, MY_PUBLIC_IP)
await bootstrap1.fullyBootstrapped()
// Your bootstrap node is now running at 67.205.140.151:49737 and it's globally accessible for anyone to use it.

// This would be the list of bootstrap nodes:
const bootstrap = [{ host: MY_PUBLIC_IP, port: bootstrap1.address().port }]
// You can achieve redundancy by having 2-3 servers with the same setup (PART 1 + PART 2) in each one.

// [THREE IMPORTANT CONCEPTS]
// We would like to use our new bootstrap to create nodes but before that:
// By default, all nodes joining a DHT network are considered ephemeral nodes.

// What is "ephemeral"?
// 1) Low uptime (less than ~30 mins online).
// 2) It may or not be firewalled.

// Nodes adapt themselves by itselfs. After a good time they can automatically become persistent nodes.

// What is "persistent"?
// 1) High uptime (at least ~30 mins online).
// 2) It's not firewalled (ports are not blocked).
// Example: a node in your home computer may never be adapted to "persistent" as you're probably behind a firewall.
// Persistent nodes are a bit special as they join other nodes routing table, so they need to be accessible (no firewall).

// What is a "bootstrap node"?
// 1) You know the ip:port (i.e. static IP or DNS).
// 2) It's not firewalled.
// 3) It's always running, as it has to be online for new nodes to join.

// [PART 2]
// Besides the bootstrap node, to have a complete DHT network: we need one persistent node.

// You could have nodes that organically become persistent, but that takes ~30 mins.
// Our network is new and no one is using it, so we need to create a forced persistent node to avoid waiting.

// Inside the same server, create a new persistent node:
const persistent1 = new DHT({ bootstrap, ephemeral: false })
await persistent1.fullyBootstrapped()
// CAUTION:
// As we're the ones creating the network, we provide at least one persistent node, this is for the network to be fully operational.
// From now on, nobody uses the {ephemeral:false} option to create nodes, otherwise you could damage the network health.
// If you or other people wants to provide more persistent nodes then everyone must wait to organically become persistent.

// [PART 3]
// Now is time to use the network as a normal user!

const node1 = new DHT({ bootstrap })
const node2 = new DHT({ bootstrap })

await node1.fullyBootstrapped()
await node2.fullyBootstrapped()

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
