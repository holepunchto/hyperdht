const sodium = require('sodium-universal')
const NoiseSecretStream = require('noise-secret-stream')
const NoiseWrap = require('./noise-wrap')
const Sleeper = require('./sleeper')
const { FIREWALL, PROTOCOL, ERROR } = require('./constants')

module.exports = function connect (dht, publicKey, opts = {}) {
  const encryptedSocket = new NoiseSecretStream(true, null, { autoStart: false })

  const c = {
    dht,
    target: hash(publicKey),
    handshake: new NoiseWrap(opts.keyPair || dht.defaultKeyPair, publicKey),
    request: null,
    protocols: PROTOCOL.TCP | PROTOCOL.UTP,
    firewall: FIREWALL.UNKNOWN,
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

  if (!c.connected) { // TODO: just a quick fix for now, should retry prob
    c.encryptedSocket.destroy(new Error('Received invalid handshake'))
    return
  }

  await holepunch(c, opts)
}

async function holepunch (c, opts) {
  let { relayAddress, serverAddress, clientAddress, payload } = c.connected

  const remoteHolepunchable = !!(payload.holepunch && payload.holepunch.relays.length)

  if ((payload.protocols & c.protocols) === 0) {
    c.encryptedSocket.destroy(new Error('No shared transport protocols'))
    return
  }

  const connecting = c.pair.connect(payload.addresses, serverAddress, clientAddress)

  if (!remoteHolepunchable && !connecting) {
    c.encryptedSocket.destroy(new Error('Cannot holepunch to remote'))
    return
  }

  if (connecting) {
    return
  }

  // Open a socket for holepunching...
  c.pair.open()

  const serverRelay = pickServerRelay(payload.holepunch.relays, relayAddress)

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
  if (opts.holepunch && !opts.holepunch(c.pair.remoteFirewall, c.pair.nat.firewall, c.pair.remoteAddress, c.pair.nat.address)) {
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
    // If we have a stable server address, send it over now
    const addr = c.dht._sockets.remoteServerAddress()

    c.firewall = c.dht.firewalled ? FIREWALL.UNKNOWN : FIREWALL.OPEN
    c.request = c.handshake.send({
      error: ERROR.NONE,
      firewall: c.firewall,
      protocols: c.protocols,
      holepunch: null,
      addresses: addr ? [addr] : []
    })
  }

  const { serverAddress, clientAddress, relayed, noise } = await c.dht._router.connect(c.target, { noise: c.request }, node.from)
  if (isDone(c) || c.connected) return

  const payload = c.handshake.recv(noise)
  if (!payload) return

  if (payload.version !== 1) {
    c.encryptedSocket.destroy(new Error('Server is using an incompatible version'))
    return
  }

  const hs = c.handshake.final()

  c.handshake = null
  c.request = null
  c.connected = {
    relayed,
    relayAddress: node.from,
    clientAddress,
    serverAddress,
    payload
  }

  c.pair = c.dht._sockets.pair(hs)

  // Track the firewall state we just exchanged on the pair instance since it needs that
  c.pair.remoteFirewall = payload.firewall
  c.pair.firewall = c.firewall

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
    id: c.connected.payload.holepunch.id,
    payload: c.pair.payload.encrypt(payload),
    peerAddress,
    socket: c.pair.socket
  }, relayAddr)

  const remotePayload = c.pair.payload.decrypt(holepunch.payload)
  if (!remotePayload) {
    throw new Error('Invalid holepunch payload')
  }

  const { error, firewall, punching, address, remoteToken } = remotePayload
  if (error !== ERROR.NONE) {
    throw new Error('Remote aborted with error code ' + error)
  }

  const echoed = !!(remoteToken && payload.token && remoteToken.equals(payload.token))

  if (firewall !== FIREWALL.UNKNOWN && address) {
    c.pair.remoteFirewall = firewall
    c.pair.remoteAddress = address
  }
  if (echoed && c.pair.remoteAddress && c.pair.remoteAddress.host === peerAddress.host) {
    c.pair.remoteVerified = true
  }
  if (punching) {
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

  c.pair.update()

  const reply = await updateHolepunch(c, serverRelay.peerAddress, serverRelay.relayAddress, {
    error: ERROR.NONE,
    firewall: c.pair.firewall,
    punching: false,
    address: c.pair.address,
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
  if (c.pair.remoteFirewall < FIREWALL.RANDOM && address && address.host && address.port && diffAddress(address, serverAddress)) {
    await c.pair.openSession(address)
    if (isDone(c)) return null
  }

  // If the remote told us they didn't know their nat firewall yet, give them a chance to figure it out
  // They might say this to see if the "fast mode" punch comes through first.
  if (c.pair.remoteFirewall === FIREWALL.UNKNOWN) {
    await c.sleeper.pause(1000)
    if (isDone(c)) return null
  }

  await c.pair.nat.analyzing
  if (isDone(c)) return null

  if (c.pair.unstable()) {
    if ((await c.pair.reopen())) {
      if (isDone(c)) return null
      return roundOne(c, serverAddress, serverRelay, false)
    }
  }

  if ((c.pair.remoteFirewall === FIREWALL.UNKNOWN || !token) && retry) {
    return roundOne(c, serverAddress, serverRelay, false)
  }

  if (c.pair.remoteFirewall === FIREWALL.UNKNOWN || c.pair.nat.firewall === FIREWALL.UNKNOWN) {
    await abort(c, serverRelay, new Error('Holepunching probe did not finish in time'))
    return null
  }

  if (c.pair.remoteFirewall >= FIREWALL.RANDOM && c.pair.nat.firewall >= FIREWALL.RANDOM) {
    await abort(c, serverRelay, new Error('Both remote and local NATs are randomized'))
    return null
  }

  return { token, peerAddress }
}

async function roundTwo (c, serverAddress, remoteToken, clientRelay) {
  c.pair.update()

  await updateHolepunch(c, serverAddress, clientRelay, {
    error: ERROR.NONE,
    firewall: c.pair.firewall,
    punching: true,
    address: c.pair.address,
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
      error: ERROR.ABORTED,
      firewall: FIREWALL.UNKNOWN,
      punching: false,
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
