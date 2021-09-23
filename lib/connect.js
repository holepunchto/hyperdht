const sodium = require('sodium-universal')
const NoiseSecretStream = require('noise-secret-stream')
const NoiseWrap = require('./noise-wrap')
const Sleeper = require('./sleeper')

const PROBE = 0
const PUNCH = 1
const ABORT = 2

module.exports = function connect (dht, publicKey, opts = {}) {
  const encryptedSocket = new NoiseSecretStream(true, null, { autoStart: false })

  const c = {
    dht,
    target: hash(publicKey),
    handshake: new NoiseWrap(opts.keyPair || dht.defaultKeyPair, publicKey),
    request: null,
    firewalled: true,
    connected: null,
    query: null,
    pair: null,
    sleeper: new Sleeper(),
    encryptedSocket
  }

  encryptedSocket.on('close', function () {
    if (c.query) c.query.destroy()
    if (c.pair) c.pair.destroy()
    c.sleeper.resume()
  })

  // Safe to run in the background - never throws
  connectAndHolepunch(c, opts)

  return encryptedSocket
}

function isDone (c) {
  return c.encryptedSocket.destroyed || !!(c.pair && c.pair.connected)
}

async function connectAndHolepunch (c, opts) {
  await findAndConnect(c, opts)
  if (isDone(c)) return
  await holepunch(c, opts)
}

async function holepunch (c, opts) {
  let { relayed, relayAddress, serverAddress, payload } = c.connected

  if (!c.firewalled && payload.firewalled) {
    // Remote will connect to us, do nothing as we'll get a connection or timeout
    return
  }

  if (!relayed || !payload.relays.length || !payload.firewalled) {
    const addr = payload.address || serverAddress
    // TODO: check what protocol to use now ie, if (supportsTCP) connect(addr, TCP)
    c.pair.connect(addr)
    return
  }

  // Open a socket for holepunching...
  c.pair.open()

  const serverRelay = pickServerRelay(payload.relays, relayAddress)

  // Begin holepunching!

  let one
  try {
    one = await roundOne(c, serverAddress, serverRelay, true)
  } catch (err) {
    // TODO: we should retry here with some of the other relays, bail for now
    c.encryptedSocket.destroy(err)
    return
  }

  if (isDone(c)) return
  const { token, peerAddress } = one

  // TODO: still continue here if a local connection might work, but then do not holepunch...
  if (opts.holepunch && !opts.holepunch(c.pair.remoteNat, c.pair.nat.type, c.pair.remoteAddress, c.pair.nat.address)) {
    await abort(c, serverRelay, new Error('Client aborted holepunch'))
    return
  }

  // If the relay the server picked is the same as the relay the client picked,
  // then we can use the peerAddress that round one indicates the server wants to use.
  // This shaves off a roundtrip if the server chose to reroll its socket due to some NAT
  // issue with the first one it picked (ie mobile nat inconsistencies...).
  // If the relays were different, then the server would not have a UDP session open on this address
  // to the client relay, which round2 uses.
  if (!diffAddress(serverRelay.relayAddress, relayAddress) && diffAddress(serverAddress, peerAddress)) {
    serverAddress = peerAddress
    await c.pair.openSession(serverAddress)
    if (isDone(c)) return
  }

  try {
    await roundTwo(c, serverAddress, token, relayAddress)
  } catch (err) {
    // TODO: retry with another relay?
    c.encryptedSocket.destroy(err)
  }
}

async function findAndConnect (c, opts) {
  c.query = c.dht.query({ command: 'find_peer', target: c.target })

  let found = null

  try {
    for await (const data of c.query) {
      if (data.value) {
        found = data
        break
      }
    }
  } catch (err) {
    c.query = null
    c.encryptedSocket.destroy(err)
    return
  }

  c.query = null
  if (isDone(c)) return

  if (!found) {
    c.encryptedSocket.destroy(new Error('Could not find peer'))
    return
  }

  try {
    await connectThroughNode(c, found)
  } catch (err) {
    c.encryptedSocket.destroy(err)
  }
}

async function connectThroughNode (c, node) {
  if (!c.request) {
    c.firewalled = c.dht.firewalled
    c.request = c.handshake.send({
      firewalled: c.firewalled,
      id: 0,
      relays: []
    })
  }

  const { serverAddress, relayed, noise } = await c.dht._router.connect(c.target, { noise: c.request }, node.from)
  if (isDone(c) || c.connected) return

  const payload = c.handshake.recv(noise)
  if (!payload) return

  const hs = c.handshake.final()

  c.handshake = null
  c.request = null
  c.connected = {
    relayed,
    relayAddress: node.from,
    serverAddress,
    payload
  }

  c.pair = c.dht._sockets.pair(hs)

  c.pair.onconnection = (rawSocket, data, ended, handshake) => {
    c.encryptedSocket.start(rawSocket, {
      handshake,
      data,
      ended
    })
  }

  c.pair.ondestroy = (err) => {
    c.encryptedSocket.destroy(err || new Error('Connect aborted'))
    c.sleeper.resume()
  }
}

async function updateHolepunch (c, peerAddress, relayAddr, payload) {
  const holepunch = await c.dht._router.holepunch(c.target, {
    id: c.connected.payload.id,
    payload: c.pair.payload.encrypt(payload),
    peerAddress,
    socket: c.pair.socket
  }, relayAddr)

  const remotePayload = c.pair.payload.decrypt(holepunch.payload)
  if (!remotePayload) {
    throw new Error('Invalid holepunch payload')
  }

  const { status, nat, address, remoteToken } = remotePayload
  if (status === ABORT) {
    throw new Error('Remote aborted')
  }

  const echoed = !!(remoteToken && payload.token && remoteToken.equals(payload.token))

  // TODO: move these conditions to a function, if not complex, as they are used in both client/server
  if (c.pair.remoteNat === 0 && nat !== 0 && address && (c.pair.remoteNat !== 1 || address.port !== 0)) {
    c.pair.remoteNat = nat
    c.pair.remoteAddress = address
  }
  if (echoed && c.pair.remoteAddress && c.pair.remoteAddress.host === peerAddress.host) {
    c.pair.remoteVerified = true
  }
  if (status === PUNCH) {
    c.pair.remoteHolepunching = true
  }

  return {
    ...holepunch,
    payload: remotePayload
  }
}

async function roundOne (c, serverAddress, serverRelay, retry) {
  // Open a quick low ttl session against what we think is the server
  await c.pair.openSession(serverAddress)
  if (isDone(c)) return null

  const reply = await updateHolepunch(c, serverRelay.peerAddress, serverRelay.relayAddress, {
    status: PROBE,
    nat: c.pair.nat.type,
    address: c.pair.nat.address,
    remoteAddress: serverAddress,
    token: null,
    remoteToken: null
  })

  if (isDone(c)) return null

  const { peerAddress } = reply
  const { address, token } = reply.payload

  c.pair.nat.add(reply.to, reply.from)

  // Open another quick low ttl session against what the server says their address is,
  // if they haven't said they are random yet
  if (c.pair.remoteNat < 2 && address && address.host && address.port && diffAddress(address, serverAddress)) {
    await c.pair.openSession(address)
    if (isDone(c)) return null
  }

  // If the remote told us they didn't know their nat type yet, give them a chance to figure it out
  // They might say this to see if the "fast mode" punch comes through first.
  if (c.pair.remoteNat === 0) {
    await c.sleeper.pause(1000)
    if (isDone(c)) return null
  }

  await c.pair.nat.analyzing
  if (isDone(c)) return null

  if (c.pair.remoteNat >= 2 && c.pair.nat.type >= 2) {
    if ((await c.pair.reopen())) {
      if (isDone(c)) return null
      return roundOne(c, serverAddress, serverRelay, false)
    }
  }

  if ((c.pair.remoteNat === 0 || !token) && retry) {
    return roundOne(c, serverAddress, serverRelay, false)
  }

  if (c.pair.remoteNat === 0 || c.pair.nat.type === PROBE) {
    await abort(c, serverRelay, new Error('Holepunching probe did not finish in time'))
    return null
  }

  if (c.pair.remoteNat >= 2 && c.pair.nat.type >= 2) {
    await abort(c, serverRelay, new Error('Both remote and local NATs are randomized'))
    return null
  }

  return { token, peerAddress }
}

async function roundTwo (c, serverAddress, remoteToken, clientRelay) {
  await updateHolepunch(c, serverAddress, clientRelay, {
    status: PUNCH,
    nat: c.pair.nat.type,
    address: c.pair.nat.address,
    remoteAddress: null,
    token: c.pair.payload.token(serverAddress),
    remoteToken
  })

  if (!c.pair.remoteVerified) {
    // TODO: if the remote changed their address here should we ping them one final time?
    throw new Error('Could not verify remote address')
  }
  if (!c.pair.remoteHolepunching) {
    throw new Error('Remote is not holepunching')
  }

  await c.pair.punch()
}

async function abort (c, { peerAddress, relayAddress }, err) {
  try {
    await updateHolepunch(peerAddress, relayAddress, {
      status: ABORT,
      nat: 0,
      address: null,
      remoteAddress: null,
      token: null,
      remoteToken: null
    })
  } catch {}
  c.encryptedSocket.destroy(err)
}

function pickServerRelay (relays, clientRelay) {
  for (const r of relays) {
    if (!diffAddress(r.relayAddress, clientRelay)) return r
  }
  return relays[0]
}

function diffAddress (a, b) {
  return a.host !== b.host || a.port !== b.port
}

function hash (data) {
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, data)
  return out
}
