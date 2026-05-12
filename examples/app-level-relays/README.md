# App-level relay selection playground

This playground shows how an app can use user-controlled blind relays before
there is any global relay discovery.

It models a small group chat app with:

- normal participants: Bob and Carol
- relay-capable participants: Alice and Dana
- in-memory group metadata listing only relays explicitly enabled by group
  members

Run it from the repository root:

```sh
node examples/app-level-relays
```

The example starts an isolated local DHT testnet, then runs these flows:

1. Alice and Dana enable relay mode with `dht.createRelayServer()`.
2. The app publishes their relay public keys into group metadata.
3. Carol starts a group chat server.
4. Bob connects to Carol with `relayThrough` selected from group metadata.
5. Bob and Carol exchange chat messages through Alice's relay.
6. Alice disables relay mode with `relay.close({ force: true })` while an active
   chat session is open.
7. The active relayed chat closes or fails.
8. Bob opens a new chat connection, and the app selects Dana from group
   metadata.
9. Dana disables relay mode, leaving no app-approved relays.

The app metadata contains relay identity and freshness only:

```js
{
  owner,
  ownerPublicKey,
  publicKey,
  protocol: 'hyperdht-blind-relay',
  version: 1,
  updatedAt,
  expiresAt
}
```

The app never shares blind-relay pairing tokens. HyperDHT creates those tokens
for each connection attempt and carries them in the handshake. `relayThrough`
is dynamic at the app level, but fixed for a single connection attempt.

This example does not implement automatic HyperDHT relay failover for an active
connection. Instead, it demonstrates the simpler first rollout shape: when app
settings or group metadata change, the next chat connection can select another
fresh, group-approved relay.

This intentionally does not implement global relay discovery, dynamic load
balancing, capacity markets, relay scoring, or third-party relay use.
