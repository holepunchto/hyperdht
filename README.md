# hyperdht

### [See the full API docs at docs.holepunch.to](https://docs.holepunch.to/building-blocks/hyperswarm#dht)

The DHT powering Hyperswarm

```
npm install hyperdht
```

Built on top of [dht-rpc](https://github.com/mafintosh/dht-rpc).

The Hyperswarm DHT uses a series of holepunching techniques to make sure connectivity works on most networks,
and is mainly used to facilitate finding and connecting to peers using end to end encrypted Noise streams.

## Usage

To try it out, first instantiate a DHT instance

``` js
import DHT from 'hyperdht'

const node = new DHT()
```

Then on one computer listen for connections

``` js
// create a server to listen for secure connections
const server = node.createServer()

server.on('connection', function (socket) {
  // socket is E2E encrypted between you and the other peer
  console.log('Remote public key', socket.remotePublicKey)

  // pipe it somewhere like any duplex stream
  process.stdin.pipe(socket).pipe(process.stdout)
})

// make a ed25519 keypair to listen on
const keyPair = DHT.keyPair()

// this makes the server accept connections on this keypair
await server.listen(keyPair)
```

Then on another connect to the computer using the public key of the key-pair it is listening on

``` js
// publicKey here is keyPair.publicKey from above
const socket = anotherNode.connect(publicKey)

socket.on('open', function () {
  // socket fully open with the other peer
})

// pipe it somewhere like any duplex stream
process.stdin.pipe(socket).pipe(process.stdout)
```

## API

#### `const node = new DHT([options])`

Create a new DHT node.

Options include:

```js
{
  // Optionally overwrite the default bootstrap servers, just need to be an array of any known dht node(s)
  // Defaults to Pear.config.dht.bootstrap in a Pear app or ['88.99.3.86@node1.hyperdht.org:49737', '142.93.90.113@node2.hyperdht.org:49737', '138.68.147.8@node3.hyperdht.org:49737'] elsewhere
  // Supports suggested-IP to avoid DNS calls: [suggested-IP@]<host>:<port>
  bootstrap: ['host:port'],
  keyPair, // set the default key pair to use for server.listen and connect
  connectionKeepAlive, // set a default keep-alive (in ms) on all opened sockets. Defaults to 5000. Set false to turn off (advanced usage).
  randomPunchInterval: 20000 // set a default time for interval between punches (in ms). Defaults to 20000.  
  
}
```

See [dht-rpc](https://github.com/mafintosh/dht-rpc) for more options as HyperDHT inherits from that.

*Note:* The default bootstrap servers are publicly served on behalf of the commons. To run a fully isolated DHT, start one or more dht nodes with an empty bootstrap array (`new DHT({bootstrap:[]})`) and then use the addresses of those nodes as the `bootstrap` option in all other dht nodes. You'll need at least one persistent node for the network to be completely operational.

#### `keyPair = DHT.keyPair([seed])`

Use this method to generate the required keypair for DHT operations.

Returns an object with `{publicKey, secretKey}`. `publicKey` holds a public key buffer, `secretKey` holds a private key buffer.

If you pass any options they are forwarded to dht-rpc.

#### `await node.destroy([options])`

Fully destroy this DHT node.

This will also unannounce any running servers.
If you want to force close the node without waiting for the servers to unannounce pass `{ force: true }`.

#### `node = DHT.bootstrapper(port, host, [options])`

If you want to run your own Hyperswarm network use this method to easily create a bootstrap node.

## Creating P2P servers

#### `const server = node.createServer([options], [onconnection])`

Create a new server for accepting incoming encrypted P2P connections.

Options include:

```js
{
  firewall (remotePublicKey, remoteHandshakePayload) {
    // validate if you want a connection from remotePublicKey
    // if you do return false, else return true
    // remoteHandshakePayload contains their ip and some more info
    return true
  }
}
```

You can run servers on normal home computers, as the DHT will UDP holepunch connections for you.

#### `await server.listen(keyPair)`

Make the server listen on a keyPair.
To connect to this server use keyPair.publicKey as the connect address.

#### `server.refresh()`

Refresh the server, causing it to reannounce its address. This is automatically called on network changes.

#### `server.on('connection', socket)`

Emitted when a new encrypted connection has passed the firewall check.

`socket` is a [NoiseSecretStream](https://github.com/holepunchto/hyperswarm-secret-stream) instance.

You can check who you are connected to using `socket.remotePublicKey` and `socket.handshakeHash` contains a unique hash representing this crypto session (same on both sides).

#### `server.on('listening')`

Emitted when the server is fully listening on a keyPair.

#### `server.address()`

Returns an object containing the address of the server:

```js
{
  host, // external IP of the server,
  port, // external port of the server if predictable,
  publicKey // public key of the server
}
```

You can also get this info from `node.remoteAddress()` minus the public key.

#### `await server.close()`

Stop listening.

#### `server.on('close')`

Emitted when the server is fully closed.

## Connecting to P2P servers

#### `const socket = node.connect(remotePublicKey, [options])`

Connect to a remote server. Similar to `createServer` this performs UDP holepunching for P2P connectivity.

The remote public key can be encoded as either a buffer, a hex string or a z-base32 string.

Options include:

```js
{
  nodes: [...], // optional array of close dht nodes to speed up connecting
  keyPair // optional key pair to use when connection (defaults to node.defaultKeyPair)
}
```

#### `socket.on('open')`

Emitted when the encrypted connection has been fully established with the server.

#### `socket.remotePublicKey`

The public key of the remote peer.

#### `socket.publicKey`

The public key of the local socket.

## Additional peer discovery

#### `const stream = node.lookup(topic, [options])`

Look for peers in the DHT on the given topic. Topic should be a 32 byte buffer (normally a hash of something).

The returned stream looks like this

```js
{
  // Who sent the response?
  from: { id, host, port },
  // What address they responded to (i.e. your address)
  to: { host, port },
  // List of peers announcing under this topic
  peers: [ { publicKey, nodes: [{ host, port }, ...] } ]
}
```

To connect to the peers you should afterwards call `connect` with those public keys.

If you pass any options they are forwarded to dht-rpc.

#### `const stream = node.announce(topic, keyPair, [relayAddresses], [options])`

Announce that you are listening on a key-pair to the DHT under a specific topic.

When announcing you'll send a signed proof to peers that you own the key-pair and wish to announce under the specific topic. Optionally you can provide up to 3 nodes, indicating which DHT nodes can relay messages to you - this speeds up connects later on for other users.

An announce does a parallel lookup so the stream returned looks like the lookup stream.

Creating a server using `dht.createServer` automatically announces itself periodically on the key-pair it is listening on. When announcing the server under a specific topic, you can access the nodes it is close to using `server.nodes`.

If you pass any options they are forwarded to dht-rpc.

#### `await node.unannounce(topic, keyPair, [options])`

Unannounce a key-pair.

If you pass any options they are forwarded to dht-rpc.

## Mutable/immutable records

#### `const { hash, closestNodes } = await node.immutablePut(value, [options])`

Store an immutable value in the DHT. When successful, the hash of the value is returned.

If you pass any options they are forwarded to dht-rpc.

#### `const { value, from } = await node.immutableGet(hash, [options])`

Fetch an immutable value from the DHT. When successful, it returns the value corresponding to the hash.

If you pass any options they are forwarded to dht-rpc.

#### `const { publicKey, closestNodes, seq, signature } = await node.mutablePut(keyPair, value, [options])`

Store a mutable value in the DHT.

If you pass any options they are forwarded to dht-rpc.

#### `const { value, from, seq, signature } = await node.mutableGet(publicKey, [options])`

Fetch a mutable value from the DHT.

Options:

* `seq` - OPTIONAL, default `0`, a number which will only return values with corresponding `seq` values that are greater than or equal to the supplied `seq` option.
* `latest` - OPTIONAL - default `false`, a boolean indicating whether the query should try to find the highest seq before returning, or just the first verified value larger than `options.seq` it sees.

Any additional options you pass are forwarded to dht-rpc.

## Additional API

See [dht-rpc](https://github.com/mafintosh/dht-rpc) for the additional APIs the DHT exposes.

## CLI

You can start a DHT node in the command line:

```sh
npm install -g hyperdht
```

Run a DHT node:
```sh
hyperdht # [--port 0] [--host 0.0.0.0] [--bootstrap <comma separated list of ip:port>]
```

Or run multiple nodes:
```sh
hyperdht --nodes 5 # [--host 0.0.0.0] [--bootstrap <list>]
```

Note: by default it uses the [mainnet bootstrap nodes](lib/constants.js).

#### Isolated DHT network

To create your own DHT network is as follows:

1) Run your first bootstrap node:
```sh
hyperdht --bootstrap --host (server-ip) # [--port 49737]
```

Important: it requires the port to be open.

Now your bootstrap node is ready to use at `(server-ip):49737`, for example:
```js
const dht = new DHT({ bootstrap: ['(server-ip):49737'] })
```

Note: You could configure some DNS for the bootstrap IP addresses.

For the network to be fully operational it needs at least one persistent node.

2) Provide the first node by using your own bootstrap values:

```sh
hyperdht --port 49738 --bootstrap (server-ip):49737
```

Important: it requires the port to be open too.

You need to wait ~30 mins for the node to become persistent.

Having persistent nodes in different places makes the network more decentralized and resilient!

For more information: [`examples/isolated-dht.mjs`](examples/isolated-dht.mjs)

## License

MIT
