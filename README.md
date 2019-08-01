# @hyperswarm/dht

The DHT powering the HyperSwarm stack

```
npm install @hyperswarm/dht
```

## Usage

``` js
const dht = require('@hyperswarm/dht')
const crypto = require('crypto')

const node = dht({
  // just join as an ephemeral node
  // as we are shortlived
  ephemeral: true
})

const topic = crypto.randomBytes(32)

// announce a port
node.announce(topic, { port: 12345 }, function (err) {
  if (err) throw err

  // try and find it
  node.lookup(topic)
    .on('data', console.log)
    .on('end', function () {
      // unannounce it and shutdown
      node.unannounce(topic, { port: 12345 }, function () {
        node.destroy()
      })
    })
})
```

## API

#### `const node = dht([options])`

Create a new HyperSwarm DHT node.

Options include:

```js
{
  // Optionally overwrite the default bootstrap servers
  bootstrap: ['host:port'],
  // If you are a shortlived client or don't want to host
  // data join as an ephemeral node. (defaults to false)
  ephemeral: true,
  // time until a peer is dropped
  maxAge: 12 * 60 * 1000
}
```

#### `node.holepunch(peer, [callback])`

UDP holepunch to another peer.

`peer` should be a `{ host, port, referrer: { host, port } }`,
where referrer should be the host and port of the DHT node who told you about this peer.

#### `const stream = node.lookup(topic, [options], [callback])`

Look for peers in the DHT on the given topic. Topic should be a 32 byte buffer (normally a hash of something).

Options include:

```js
{
  // Optionally set your public port. This will make
  // other peers no echo back yourself
  port: 12345,
  // Optionally look for LAN addresses as well by
  // passing in your own. Will also exclude yourself from
  // the results. Only LAN addresses announced on the
  // same public IP and sharing the first two parts (192.168)
  // will be included.
  localAddress: {
    host: '192.168.100.100',
    port: 20000
  }
}
```

The returned stream looks like this

```js
{
  // The DHT node that is returning this data
  node: { host, port },
  // List of peers
  peers: [ { host, port }, ... ],
  // List of LAN peers
  localPeers: [ { host, port }, ... ]
}
```

If you pass the callback the stream will be error handled and buffered.

#### `const stream = node.announce(topic, [options], [callback])`

Announce a port to the dht.

Options include:

```js
{
  // Explicitly set the port you want to announce.
  // Per default you UDP socket port is announced.
  port: 12345,
  // Optionally announce a LAN address as well.
  // Only people with the same public IP as you will
  // get these when doing a lookup
  localAddress: {
    host: '192.168.100.100',
    port: 20000
  }
}
```

An announce does a parallel lookup so the stream returned looks like the lookup stream.
If you pass a callback the stream will be error handled and buffered.

#### `node.unannounce(topic, [options], [callback])`

Unannounce a port. Takes the same options as announce.

#### `node.destroy()`

Fully destroy this DHT node.

#### `node.listen([port])`

Explicitly listen on a UDP port.
If you do not call this it will use a random free port.


#### `node.immutable.put(value, callback = (err, key) => {}) => stream`

Store an immutable value in the DHT. When successful, the second argument passed
to `callback` contains the generated key (a hash) for that value.


#### `node.immutable.get(key, callback = (err, value) => {}) => stream`

Fetch an immutable value from the DHT. When successful, the second argument passed to `callback` contains the resolved value.

#### `node.immutable.get(key) => stream`

Fetch all matching immutable values from the DHT. Any found values are emited in `data` events.

#### `node.mutable.keypair()`

Use this method to generate the required keypair for a put.
Returns an object with `{publicKey, secretKey}`. `publicKey` holds a public key buffer, `secretKey` holds a private key buffer.

#### `node.mutable.salt(size = 32)`

Utility method for creating a random salt value. This can optionally
be passed in `mutable.put` and `mutable.get` options.
Salt values can be used as a sort of secondary UID, allowing multiple values to be stored under the same public key. Min `size` is 16 bytes, max `size` is 64 bytes.

#### `node.mutable.put(value, options, callback = (err, { key, ...info }) => {}) => stream`

Store a mutable value in the DHT.

Options:

* keypair – REQUIRED, use `node.mutable.keypair` to generate this.
* seq - OPTIONAL - default `0`, a number which should be increased every time put is passed a new value for the same keypair
* salt - OPTIONAL - default `undefined`, a buffer >= 16 and <= 64 bytes. If supplied it will salt the signature used to verify mutable values.

When successful the second argument passed to `callback` is an object containing the public key as `key`, with additional meta data (`...info`): `sig`, `seq`, `salt`. 

#### `node.mutable.get(key, [options], callback = (err, { value, ...info }) => {}) => stream`

Fetch a mutable value from the DHT. 

Options:

* seq - OPTIONAL, default `0`, a number which will only return values with corresponding `seq` values that are greater than or equal to the supplied `seq` option.
* salt - OPTIONAL - default `undefined`, a buffer >= 16 and <= 64 bytes. If supplied it will salt the signature used to verify mutable values.

When successful, the second argument passed to `callback` is an object containing the resolved `value` with additional meta data (`...info`): `sig`, `seq` and `salt`.

#### `node.immutable.get(key) => stream`

Fetch all matching mutable values from the DHT.

Any values found are emitted in a `data` event where the data object takes the form: `{value, sig, seq, salt}`.

#### Put / Get Stream Interface

All mutable and immutable Put / Get methods return a stream.

In addition to usual Node.js stream behaviour, the returned stream 
will emit `warning` events which may contain error information from other
Nodes. The stream instance also has the following stat counters

* `inflight` - how many requests are currently active/ongoing
* `responses` - how many responses have been received
* `errors` - how many errors occured (locally)
* `updates` - how many updates were made

#### `node.on('listening')`

Emitted when the node starts listening

#### `node.on('close')`

Emitted when the node is fully closed.

#### `node.on('announce', topic, peer)`

Emitted when an announce is received.

#### `node.on('unannounce', topic, peer)`

Emitted when an unannounce is received.

#### `node.on('lookup', topic, peer)`

Emitted when a lookup is received.

## CLI

There is a CLI available as well.

```sh
npm install -g @hyperswarm/dht
hyperswarm-dht # runs a DHT node
```

## License

MIT
