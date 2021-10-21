# @hyperswarm/dht

The DHT powering the HyperSwarm network

```
npm install @hyperswarm/dht@next
```

Built on top of [dht-rpc](https://github.com/mafintosh/dht-rpc).

The Hyperswarm DHT uses a series of hole punching techniques to make sure connectivity works on most networks,
and is mainly used to facilitate finding and connecting to peers using end to end encrypted Noise streams.

## NOTE: v5

Note that this is the README for v5 which is tagged under next.
To see the v4 documentation/code go to https://github.com/hyperswarm/dht/tree/v4

As v5 fully matures over the next month it will be shifted to npm latest.

## Usage

To try it out, first instantiate a DHT instance

``` js
import DHT from '@hyperswarm/dht'

const node = new DHT()
```

Then on one computer listen for connections

``` js
// create a server to listen for secure connections
const server = node.createServer()

server.on('connection', function (noiseSocket) {
  // noiseSocket is E2E between you and the other peer
  // pipe it somewhere like any duplex stream

  console.log('Remote public key', noiseSocket.remotePublicKey)
  console.log('Local public key', noiseSocket.publicKey) // same as keyPair.publicKey

  process.stdin.pipe(noiseSocket).pipe(process.stdout)
})

// make a ed25519 keypair to listen on
const keyPair = DHT.keyPair()

// this makes the server accept connections on this keypair
await server.listen(keyPair)
```

Then on another connect to the computer using the public key of the key-pair it is listening on

``` js
// publicKey here is keyPair.publicKey from above
const noiseSocket = anotherNode.connect(publicKey)

noiseSocket.on('open', function () {
  // noiseSocket fully open with the other peer
})

// pipe it somewhere like any duplex stream
process.stdin.pipe(noiseSocket).pipe(process.stdout)
```

## API

#### `const node = new DHT([options])`

Create a new HyperSwarm DHT node.

Options include:

```js
{
  // Optionally overwrite the default bootstrap servers
  // Defaults to ['testnet1.hyperdht.org:49736', 'testnet2.hyperdht.org:49736', 'testnet3.hyperdht.org:49736']
  bootstrap: ['host:port'],
  keyPair // set the default key pair to use for server.listen and connect
}
```

See [dht-rpc](https://github.com/mafintosh/dht-rpc) for more options as HyperDHT inherits from that.

*Note:* The default bootstrap servers are publicly served on behalf of the commons. To run a fully private DHT, start two or more dht nodes with an empty bootstrap array (`new DHT({bootstrap:[]})`) and then use the addresses of those nodes as the `bootstrap` option in all other dht nodes.

#### `keyPair = DHT.keyPair([seed])`

Use this method to generate the required keypair for DHT operations.

Returns an object with `{publicKey, secretKey}`. `publicKey` holds a public key buffer, `secretKey` holds a private key buffer.

If you pass any options they are forwarded to dht-rpc.

#### `await node.destroy([options])`

Fully destroy this DHT node.

This will also unannounce any running servers.
If you want to force close the node without waiting for the servers to unannounce pass `{ force: true }`.

#### `node = DHT.bootstrapper(bind, [options])`

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

#### `server.on('connection', encryptedConnection)`

Emitted when a new encrypted connection has passed the firewall check.

`encryptedConnection` is a [NoiseSecretStream](https://github.com/mafintosh/noise-secret-stream) instance.

You can check who you are connected to using `encryptedConnection.remotePublicKey` and `encryptedConnection.handshakeHash` contains a unique hash representing this crypto session (same on both sides).

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

#### `const encryptedConnection = node.connect(remotePublicKey, [options])`

Connect to a remote server. Similar to `createServer` this performs UDP holepunching for P2P connectivity.

Options include:

```js
{
  nodes: [...], // optional array of close dht nodes to speed up connecting
  keyPair // optional key pair to use when connection (defaults to node.defaultKeyPair)
}
```

#### `encryptedConnection.on('open')`

Emitted when the encrypted connection has been fully established with the server.

#### `encryptedConnection.remotePublicKey`

The public key of the remote peer.

#### `encryptedConnection.publicKey`

The connections public key.

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

#### `{ hash, closestNodes } = await node.immutablePut(value, [options])`

Store an immutable value in the DHT. When successful, the hash of the value is returned.

If you pass any options they are forwarded to dht-rpc.

#### `{ value, from } = await node.immutableGet(hash, [options])`

Fetch an immutable value from the DHT. When successful, it returns the value corresponding to the hash.

If you pass any options they are forwarded to dht-rpc.

#### `await { publicKey, closestNodes, seq, signature } = node.mutablePut(keyPair, value, [options])`

Store a mutable value in the DHT.

If you pass any options they are forwarded to dht-rpc.

#### `await { value, from, seq, signature } = node.mutableGet(publicKey, [options])`

Fetch a mutable value from the DHT.

Options:

* `seq` - OPTIONAL, default `0`, a number which will only return values with corresponding `seq` values that are greater than or equal to the supplied `seq` option.
* `latest` - OPTIONAL - default `false`, a boolean indicating whether the query should try to find the highest seq before returning, or just the first verified value larger than `options.seq` it sees.

Any additional options you pass are forwarded to dht-rpc.

## Additional API

See [dht-rpc](https://github.com/mafintosh/dht-rpc) for the additional APIs the DHT exposes.

## CLI

You can start a DHT node in the command line, using the [@hyperswarm/cli](https://github.com/hyperswarm/cli) package:

```sh
npm install -g @hyperswarm/cli
hyperswarm-dht # runs a DHT node
```

## License

MIT
