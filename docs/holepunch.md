## Holepunch

After the [handshake](handshake.md) completes, the client may attempt to holepunch a direct connection to the server. Prior to this, the client checks if it has already established a direction connection to the server; this will be the case if the server also acted as the relay node during the handshake.

```mermaid
sequenceDiagram
    actor c as client node
    actor sr as server relay node
    actor s as server node

    c ->> sr: { command: PEER_HOLEPUNCH, target, value: { mode: FROM_CLIENT, ... } }
    sr ->> s: { command: PEER_HOLEPUNCH, target, value: { mode: FROM_RELAY, ... } }
    s ->> sr: { command: PEER_HOLEPUNCH, target, value: { mode: FROM_SERVER, payload: { token, ... }, ... } }
    sr -->> c: { command: PEER_HOLEPUNCH, target, value: { mode: REPLY, payload, ... } }
```

```mermaid
sequenceDiagram
    actor c as client node
    actor cr as client relay node (dht)
    actor s as server node

    c ->> cr: { command: PEER_HOLEPUNCH, target, value: { mode: FROM_CLIENT, payload: { token, remoteToken }, ... } }
    cr ->> s: { command: PEER_HOLEPUNCH, target, value: { mode: FROM_RELAY, payload,... } }

    note left of s: server can now verify that address of client is correct based on remote token

    s ->> cr: { command: PEER_HOLEPUNCH, target, value: { mode: FROM_SERVER, payload: { remoteToken, ... }, ... } }
    cr -->> c: { command: PEER_HOLEPUNCH, target, value: { mode: REPLY, payload, ... } }

    note right of c: client can now verify that address of server is correct based on remote token
```

In tandem with the holepunch messages, the client and server will attempt to ping what they believe to be the address of the other peer. The holepunch messages provide feedback to each peer of the network conditions of the other, including additional addresses that they may attempt to holepunch to. The process ends when both peers have received a ping from the other and a direction connection has then been established.
