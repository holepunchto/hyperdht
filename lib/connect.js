const NoiseSecretStream = require('@hyperswarm/secret-stream')
const b4a = require('b4a')
const relay = require('blind-relay')
const { isPrivate, isBogon } = require('bogon')
const safetyCatch = require('safety-catch')
const unslab = require('unslab')
const Semaphore = require('./semaphore')
const NoiseWrap = require('./noise-wrap')
const SecurePayload = require('./secure-payload')
const Holepuncher = require('./holepuncher')
const Sleeper = require('./sleeper')
const { FIREWALL, ERROR } = require('./constants')
const { unslabbedHash } = require('./crypto')
const {
  CANNOT_HOLEPUNCH,
  HANDSHAKE_INVALID,
  HOLEPUNCH_ABORTED,
  HOLEPUNCH_INVALID,
  HOLEPUNCH_PROBE_TIMEOUT,
  HOLEPUNCH_DOUBLE_RANDOMIZED_NATS,
  PEER_CONNECTION_FAILED,
  PEER_NOT_FOUND,
  REMOTE_ABORTED,
  REMOTE_NOT_HOLEPUNCHABLE,
  REMOTE_NOT_HOLEPUNCHING,
  SERVER_ERROR,
  SERVER_INCOMPATIBLE,
  RELAY_ABORTED,
  SUSPENDED
} = require('./errors')

module.exports = function connect (dht, publicKey, opts = {}) {
  const pool = opts.pool || null

  if (pool && pool.has(publicKey)) return pool.get(publicKey)

  publicKey = unslab(publicKey)

  const keyPair = opts.keyPair || dht.defaultKeyPair
  const relayThrough = selectRelay(opts.relayThrough || null)
  const encryptedSocket = (opts.createSecretStream || defaultCreateSecretStream)(true, null, {
    publicKey: keyPair.publicKey,
    remotePublicKey: publicKey,
    autoStart: false,
    keepAlive: dht.connectionKeepAlive
  })

  // in case a socket is made during suspended state, destroy it immediately
  if (dht.suspended || !dht._connectable) {
    encryptedSocket.destroy(SUSPENDED())
    return encryptedSocket
  }

  if (pool) pool._attachStream(encryptedSocket, false)

  const c = {
    dht,
    session: dht.session(),
    relayAddresses: opts.relayAddresses || [],
    pool,
    round: 0,
    target: unslabbedHash(publicKey),
    remotePublicKey: publicKey,
    reusableSocket: !!opts.reusableSocket,
    handshake: (opts.createHandshake || defaultCreateHandshake)(keyPair, publicKey),
    request: null,
    requesting: false,
    lan: opts.localConnection !== false,
    firewall: FIREWALL.UNKNOWN,
    rawStream: dht.createRawStream({ framed: true, firewall }),
    connect: null,
    query: null,
    puncher: null,
    payload: null,
    passiveConnectTimeout: null,
    serverSocket: null,
    serverAddress: null,
    onsocket: null,
    sleeper: new Sleeper(),
    encryptedSocket,

    // Relay state
    relayTimeout: null,
    relayThrough,
    relayToken: relayThrough ? relay.token() : null,
    relaySocket: null,
    relayClient: null,
    relayPaired: false,
    relayKeepAlive: opts.relayKeepAlive || 5000
  }

  // If the raw stream receives an error signal pre connect (ie from the firewall hook), make sure
  // to forward that to the encrypted socket for proper teardown
  c.rawStream.on('error', autoDestroy)
  c.rawStream.once('connect', () => {
    c.rawStream.removeListener('error', autoDestroy)
  })

  encryptedSocket.on('close', function () {
    if (c.passiveConnectTimeout) clearPassiveConnectTimeout(c)
    if (c.query) c.query.destroy()
    if (c.puncher) c.puncher.destroy()
    if (c.rawStream) c.rawStream.destroy()
    c.session.destroy()
    c.sleeper.resume()
  })

  // Safe to run in the background - never throws
  if (dht.suspended) encryptedSocket.destroy(SUSPENDED())
  else connectAndHolepunch(c, opts)

  return encryptedSocket

  function autoDestroy (err) {
    maybeDestroyEncryptedSocket(c, err)
  }

  function firewall (socket, port, host) {
    // Check if the traffic originated from the socket on which we're expecting relay traffic. If so,
    // we haven't hole punched yet and the other side is just sending us traffic through the relay.
    if (c.relaySocket && isRelay(c.relaySocket, socket, port, host)) {
      return false
    }

    if (c.onsocket) {
      c.onsocket(socket, port, host)
    } else {
      c.serverSocket = socket
      c.serverAddress = { port, host }
    }
    return false
  }
}

function isDone (c) {
  // we are destroying or the puncher is connected - done
  if (c.encryptedSocket.destroying || !!(c.puncher && c.puncher.connected)) {
    return true
  }
  // not destroying, but no raw stream - def not done
  if (c.encryptedSocket.rawStream === null) {
    return false
  }
  // we are relayed, but the puncher is not done yet
  if (c.relaySocket && !!(c.puncher && !c.puncher.connected && !c.puncher.destroyed)) {
    return false
  }
  // we are done
  return true
}

async function retryRoute (c, route) {
  const ref = c.dht._socketPool.lookup(route.socket)

  if (!ref) {
    if (route.socket === c.dht.socket) {
      await connectThroughNode(c, route.address, c.dht.socket)
    }
    return
  }

  ref.active()

  try {
    await connectThroughNode(c, route.address, route.socket)
  } catch {
    // if error, just ignore, and continue through the existing strat
  }

  ref.inactive()
}

async function connectAndHolepunch (c, opts) {
  const route = c.reusableSocket ? c.dht._socketPool.routes.get(c.remotePublicKey) : null

  if (route) {
    await retryRoute(c, route)
    if (isDone(c)) return
  }

  await findAndConnect(c, opts)
  if (isDone(c)) return

  if (!c.connect) { // TODO: just a quick fix for now, should retry prob
    maybeDestroyEncryptedSocket(c, HANDSHAKE_INVALID())
    return
  }

  await holepunch(c, opts)
}

function getFirstRemoteAddress (addrs, serverAddress) {
  for (const addr of addrs) {
    if (isBogon(addr.host)) continue
    return addr
  }

  return serverAddress
}

async function holepunch (c, opts) {
  let { relayAddress, serverAddress, clientAddress, payload } = c.connect

  const remoteHolepunchable = !!(payload.holepunch && payload.holepunch.relays.length)

  const relayed = diffAddress(serverAddress, relayAddress)

  if (payload.firewall === FIREWALL.OPEN || (relayed && !remoteHolepunchable)) {
    const addr = getFirstRemoteAddress(payload.addresses4, serverAddress)
    if (addr) {
      const socket = c.dht.socket
      c.dht.stats.punches.open++
      c.onsocket(socket, addr.port, addr.host)
      return
    }
    // TODO: check all addresses also obvs
  }

  const onabort = () => {
    c.session.destroy()
    maybeDestroyEncryptedSocket(c, HOLEPUNCH_ABORTED())
  }

  if (c.firewall === FIREWALL.OPEN) {
    c.passiveConnectTimeout = setTimeout(onabort, 10000)
    return
  }

  // TODO: would be better to just try local addrs in the background whilst continuing with other strategies...
  if (c.lan && relayed && clientAddress.host === serverAddress.host) {
    const serverAddresses = payload.addresses4.filter(onlyPrivateHosts)

    if (serverAddresses.length > 0) {
      const myAddresses = Holepuncher.localAddresses(c.dht.io.serverSocket)
      const addr = Holepuncher.matchAddress(myAddresses, serverAddresses) || serverAddresses[0]

      const socket = c.dht.io.serverSocket
      try {
        await c.dht.ping(addr)
      } catch {
        maybeDestroyEncryptedSocket(c, HOLEPUNCH_ABORTED())
        return
      }
      c.onsocket(socket, addr.port, addr.host)
      return
    }
  }

  if (!remoteHolepunchable) {
    maybeDestroyEncryptedSocket(c, CANNOT_HOLEPUNCH())
    return
  }

  c.puncher = new Holepuncher(c.dht, c.session, true, payload.firewall)

  c.puncher.onconnect = c.onsocket
  c.puncher.onabort = onabort

  const serverRelay = pickServerRelay(payload.holepunch.relays, relayAddress)

  // Begin holepunching!

  let probe
  try {
    probe = await probeRound(c, opts.fastOpen === false ? null : serverAddress, serverRelay, true)
  } catch (err) {
    destroyPuncher(c)
    // TODO: we should retry here with some of the other relays, bail for now
    maybeDestroyEncryptedSocket(c, err)
    return
  }

  if (isDone(c) || !probe) return
  const { token, peerAddress } = probe

  // If the relay the server picked is the same as the relay the client picked,
  // then we can use the peerAddress that round one indicates the server wants to use.
  // This shaves off a roundtrip if the server chose to reroll its socket due to some NAT
  // issue with the first one it picked (ie mobile nat inconsistencies...).
  // If the relays were different, then the server would not have a UDP session open on this address
  // to the client relay, which round2 uses.
  if (!diffAddress(serverRelay.relayAddress, relayAddress) && diffAddress(serverAddress, peerAddress)) {
    serverAddress = peerAddress
    await c.puncher.openSession(serverAddress)
    if (isDone(c)) return
  }

  // TODO: still continue here if a local connection might work, but then do not holepunch...
  if (opts.holepunch && !opts.holepunch(c.puncher.remoteFirewall, c.puncher.nat.firewall, c.puncher.remoteAddresses, c.puncher.nat.addresses)) {
    await abort(c, serverRelay, HOLEPUNCH_ABORTED('Client aborted holepunch'))
    return
  }

  try {
    await roundPunch(c, serverAddress, token, relayAddress, serverRelay, false)
  } catch (err) {
    destroyPuncher(c)
    // TODO: retry with another relay?
    maybeDestroyEncryptedSocket(c, err)
  }
}

async function findAndConnect (c, opts) {
  let attempts = 0
  let closestNodes = (opts.relayAddresses && opts.relayAddresses.length) ? opts.relayAddresses : null

  if (c.dht._persistent) { // check if we know the route ourself...
    const route = c.dht._router.get(c.target)
    if (route && route.relay !== null) closestNodes = [{ host: route.relay.host, port: route.relay.port }]
  }

  // 2 is how many parallel connect attempts we want to do, we can make this configurable
  const sem = new Semaphore(2)
  const signal = sem.signal.bind(sem)
  const tries = closestNodes !== null ? 2 : 1

  try {
    for (let i = 0; i < tries && !isDone(c) && !c.connect; i++) {
      c.query = c.dht.findPeer(c.target, { hash: false, session: c.session, closestNodes, onlyClosestNodes: closestNodes !== null })

      for await (const data of c.query) {
        await sem.wait()
        if (isDone(c)) return

        if (c.connect) {
          sem.signal()
          break
        }

        attempts++
        connectThroughNode(c, data.from, null).then(signal, signal)
      }

      closestNodes = null
    }

    c.query = null
    if (isDone(c)) return

    // flush the semaphore
    await sem.flush()
    if (isDone(c)) return
  } catch (err) {
    c.query = null
    maybeDestroyEncryptedSocket(c, err)
    return
  }

  if (!c.connect) {
    maybeDestroyEncryptedSocket(c, attempts ? PEER_CONNECTION_FAILED() : PEER_NOT_FOUND())
  }
}

async function connectThroughNode (c, address, socket) {
  if (!c.requesting) {
    // If we have a stable server address, send it over now
    const addr = c.dht.remoteAddress()
    const localAddrs = c.lan ? Holepuncher.localAddresses(c.dht.io.serverSocket) : null
    const addresses4 = []

    if (addr) addresses4.push(addr)
    if (localAddrs) addresses4.push(...localAddrs)

    c.firewall = addr ? FIREWALL.OPEN : FIREWALL.UNKNOWN
    c.requesting = true
    c.request = await c.handshake.send({
      error: ERROR.NONE,
      firewall: c.firewall,
      holepunch: null,
      addresses4,
      addresses6: [],
      udx: {
        reusableSocket: c.reusableSocket,
        id: c.rawStream.id,
        seq: 0
      },
      secretStream: {},
      relayThrough: c.relayThrough
        ? { publicKey: c.relayThrough, token: c.relayToken }
        : null
    })
    if (isDone(c)) return
  }

  const { serverAddress, clientAddress, relayed, noise } = await c.dht._router.peerHandshake(c.target, { noise: c.request, socket, session: c.session }, address)
  if (isDone(c) || c.connect) return

  const payload = await c.handshake.recv(noise)
  if (isDone(c) || !payload) return

  if (payload.version !== 1) {
    maybeDestroyEncryptedSocket(c, SERVER_INCOMPATIBLE())
    return
  }
  if (payload.error !== ERROR.NONE) {
    maybeDestroyEncryptedSocket(c, SERVER_ERROR())
    return
  }
  if (!payload.udx) {
    maybeDestroyEncryptedSocket(c, SERVER_ERROR('Server did not send UDX data'))
    return
  }

  const hs = c.handshake.final()

  c.handshake = null
  c.request = null
  c.requesting = false
  c.connect = {
    relayed,
    relayAddress: address,
    clientAddress,
    serverAddress,
    payload
  }

  c.payload = new SecurePayload(hs.holepunchSecret)

  c.onsocket = function (socket, port, host) {
    if (c.rawStream === null) return // Already hole punched

    if (c.rawStream.connected) {
      const remoteChanging = c.rawStream.changeRemote(socket, c.connect.payload.udx.id, port, host)

      if (remoteChanging) remoteChanging.catch(safetyCatch)
    } else {
      c.rawStream.connect(socket, c.connect.payload.udx.id, port, host)
      c.encryptedSocket.start(c.rawStream, { handshake: hs })
    }

    if (c.reusableSocket && payload.udx.reusableSocket) {
      c.dht._socketPool.routes.add(c.remotePublicKey, c.rawStream)
    }

    if (c.puncher) {
      c.puncher.onabort = noop
      c.puncher.destroy()
    }

    if (c.passiveConnectTimeout) {
      clearPassiveConnectTimeout(c)
    }

    c.rawStream = null
  }

  if (payload.relayThrough || c.relayThrough) {
    relayConnection(c, c.relayThrough, payload, hs)
  }

  if (c.serverSocket) {
    c.onsocket(c.serverSocket, c.serverAddress.port, c.serverAddress.host)
    return
  }

  if (!relayed) {
    c.onsocket(socket || c.dht.socket, address.port, address.host)
  }

  c.session.destroy()
}

async function updateHolepunch (c, peerAddress, relayAddr, payload) {
  const holepunch = await c.dht._router.peerHolepunch(c.target, {
    id: c.connect.payload.holepunch.id,
    payload: c.payload.encrypt(payload),
    peerAddress,
    socket: c.puncher.socket,
    session: c.session
  }, relayAddr)

  if (isDone(c)) return null

  const remotePayload = c.payload.decrypt(holepunch.payload)
  if (!remotePayload) {
    throw HOLEPUNCH_INVALID()
  }

  const { error, firewall, punching, addresses, remoteToken } = remotePayload

  if (error === ERROR.TRY_LATER && c.relayToken && payload.punching) {
    return {
      tryLater: true,
      ...holepunch,
      payload: remotePayload
    }
  }

  if (error !== ERROR.NONE) {
    throw REMOTE_ABORTED('Remote aborted with error code ' + error)
  }

  const echoed = !!(remoteToken && payload.token && b4a.equals(remoteToken, payload.token))

  c.puncher.updateRemote({ punching, firewall, addresses, verified: echoed ? peerAddress.host : null })

  return {
    tryLater: false,
    ...holepunch,
    payload: remotePayload
  }
}

async function probeRound (c, serverAddress, serverRelay, retry) {
  // Open a quick low ttl session against what we think is the server
  if (serverAddress) await c.puncher.openSession(serverAddress)

  if (isDone(c)) return null

  const reply = await updateHolepunch(c, serverRelay.peerAddress, serverRelay.relayAddress, {
    error: ERROR.NONE,
    firewall: c.puncher.nat.firewall,
    round: c.round++,
    connected: false,
    punching: false,
    addresses: c.puncher.nat.addresses,
    remoteAddress: serverAddress,
    token: null,
    remoteToken: null
  })

  if (isDone(c) || !reply) return null

  const { peerAddress } = reply
  const { address, token } = reply.payload

  c.puncher.nat.add(reply.to, reply.from)

  // Open another quick low ttl session against what the server says their address is,
  // if they haven't said they are random yet
  if (c.puncher.remoteFirewall < FIREWALL.RANDOM && address && address.host && address.port && diffAddress(address, serverAddress)) {
    await c.puncher.openSession(address)
    if (isDone(c)) return null
  }

  // If the remote told us they didn't know their nat firewall yet, give them a chance to figure it out
  // They might say this to see if the "fast mode" punch comes through first.
  if (c.puncher.remoteFirewall === FIREWALL.UNKNOWN) {
    await c.sleeper.pause(1000)
    if (isDone(c)) return null
  }

  let stable = await c.puncher.analyze(false)
  if (isDone(c)) return null

  // If the socket seems unstable, try to make it stable by setting the "allowReopen" flag
  // Mostly relevant for mobile networks
  if (!stable) {
    stable = await c.puncher.analyze(true)
    if (isDone(c)) return null
    if (stable) return probeRound(c, serverAddress, serverRelay, false)
  }

  if ((c.puncher.remoteFirewall === FIREWALL.UNKNOWN || !token) && retry) {
    return probeRound(c, serverAddress, serverRelay, false)
  }

  if (c.puncher.remoteFirewall === FIREWALL.UNKNOWN || c.puncher.nat.firewall === FIREWALL.UNKNOWN) {
    await abort(c, serverRelay, HOLEPUNCH_PROBE_TIMEOUT())
    return null
  }

  if (c.puncher.remoteFirewall >= FIREWALL.RANDOM && c.puncher.nat.firewall >= FIREWALL.RANDOM) {
    await abort(c, serverRelay, HOLEPUNCH_DOUBLE_RANDOMIZED_NATS())
    return null
  }

  return { token, peerAddress }
}

async function roundPunch (c, serverAddress, remoteToken, clientRelay, serverRelay, delayed) {
  // We are gossiping our final NAT status to the other peer now
  // so make sure we don't update our local view for now as that can make things weird
  c.puncher.nat.freeze()

  const isRandom = c.puncher.remoteFirewall >= FIREWALL.RANDOM || c.puncher.nat.firewall >= FIREWALL.RANDOM
  if (isRandom) {
    while (c.dht._randomPunches >= c.dht._randomPunchLimit || (Date.now() - c.dht._lastRandomPunch) < c.dht._randomPunchInterval) {
      // if no relay can help, bail
      if (!c.relayToken) throw HOLEPUNCH_ABORTED()

      if (!delayed) {
        delayed = true
        await updateHolepunch(c, serverAddress, clientRelay, {
          error: ERROR.NONE,
          firewall: c.puncher.nat.firewall,
          round: c.round++,
          connected: false,
          punching: false,
          addresses: c.puncher.nat.addresses,
          remoteAddress: null,
          token: c.payload.token(serverAddress),
          remoteToken
        })
        if (isDone(c)) return
      }

      await tryLater(c)
      if (isDone(c)) return
    }
  }

  // increment now, so we can commit to punching
  if (isRandom) c.dht._randomPunches++

  let reply

  try {
    // if delayed switch to the servers chosen relay - we validated anyway
    reply = await updateHolepunch(c, delayed ? serverRelay.peerAddress : serverAddress, delayed ? serverRelay.relayAddress : clientRelay, {
      error: ERROR.NONE,
      firewall: c.puncher.nat.firewall,
      round: c.round++,
      connected: false,
      punching: true,
      addresses: c.puncher.nat.addresses,
      remoteAddress: null,
      token: delayed ? null : c.payload.token(serverAddress),
      remoteToken
    })
  } finally {
    // decrement as punch increments for us
    if (isRandom) c.dht._randomPunches--
  }

  if (isDone(c)) return
  if (!reply) return

  if (reply.tryLater) {
    await tryLater(c)
    if (isDone(c)) return
    return roundPunch(c, serverAddress, remoteToken, clientRelay, serverRelay, true)
  }

  if (!c.puncher.remoteHolepunching) {
    throw REMOTE_NOT_HOLEPUNCHING()
  }

  if (!await c.puncher.punch()) {
    throw REMOTE_NOT_HOLEPUNCHABLE()
  }
}

async function tryLater (c) {
  if (!c.relayToken) throw HOLEPUNCH_ABORTED()
  await c.sleeper.pause(10000 + Math.round(Math.random() * 10000))
}

function maybeDestroyEncryptedSocket (c, err) {
  if (isDone(c)) return
  if (c.encryptedSocket.rawStream) return
  if (c.relaySocket) return // waiting for the relay
  if (c.puncher && !c.puncher.destroyed) return // waiting for the puncher
  c.session.destroy()
  c.encryptedSocket.destroy(err)
}

async function abort (c, { peerAddress, relayAddress }, err) {
  try {
    await updateHolepunch(peerAddress, relayAddress, {
      error: ERROR.ABORTED,
      firewall: FIREWALL.UNKNOWN,
      round: c.round++,
      connected: false,
      punching: false,
      addresses: null,
      remoteAddress: null,
      token: null,
      remoteToken: null
    })
  } catch {}

  destroyPuncher(c)
  maybeDestroyEncryptedSocket(c, err)
}

function relayConnection (c, relayThrough, payload, hs) {
  let isInitiator
  let publicKey
  let token

  if (payload.relayThrough) {
    isInitiator = false
    publicKey = payload.relayThrough.publicKey
    token = payload.relayThrough.token
  } else {
    isInitiator = true
    publicKey = relayThrough
    token = c.relayToken
  }

  c.relayToken = token
  c.relaySocket = c.dht.connect(publicKey)
  c.relaySocket.setKeepAlive(c.relayKeepAlive)
  c.relayClient = relay.Client.from(c.relaySocket, { id: c.relaySocket.publicKey })
  c.relayTimeout = setTimeout(onabort, 15000, null)

  c.relayClient
    .pair(isInitiator, token, c.rawStream)
    .on('error', onabort)
    .on('data', ondata)

  function ondata (remoteId) {
    if (c.relayTimeout) clearRelayTimeout(c)
    if (c.rawStream === null) {
      onabort(null)
      return
    }

    c.relayPaired = true

    const {
      remotePort,
      remoteHost,
      socket
    } = c.relaySocket.rawStream

    c.rawStream
      .on('close', () => c.relaySocket.destroy())
      .connect(socket, remoteId, remotePort, remoteHost)

    c.encryptedSocket.start(c.rawStream, { handshake: hs })
  }

  function onabort (err) {
    if (c.relayTimeout) clearRelayTimeout(c)
    const socket = c.relaySocket
    c.relayToken = null
    c.relaySocket = null
    if (socket) socket.destroy()
    maybeDestroyEncryptedSocket(c, err || RELAY_ABORTED())
  }
}

function clearPassiveConnectTimeout (c) {
  clearTimeout(c.passiveConnectTimeout)
  c.passiveConnectTimeout = null
}

function clearRelayTimeout (c) {
  clearTimeout(c.relayTimeout)
  c.relayTimeout = null
}

function destroyPuncher (c) {
  if (c.puncher) c.puncher.destroy()
  c.session.destroy()
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

function defaultCreateHandshake (keyPair, remotePublicKey) {
  return new NoiseWrap(keyPair, remotePublicKey)
}

function defaultCreateSecretStream (isInitiator, rawStream, opts) {
  return new NoiseSecretStream(isInitiator, rawStream, opts)
}

function onlyPrivateHosts (addr) {
  return isPrivate(addr.host)
}

function isRelay (relaySocket, socket, port, host) {
  const stream = relaySocket.rawStream
  if (!stream) return false
  if (stream.socket !== socket) return false
  return port === stream.remotePort && host === stream.remoteHost
}

function selectRelay (relayThrough) {
  if (typeof relayThrough === 'function') relayThrough = relayThrough()
  if (relayThrough === null) return null
  if (Array.isArray(relayThrough)) return relayThrough[Math.floor(Math.random() * relayThrough.length)]
  return relayThrough
}

function noop () {}
