const test = require('brittle')
const HyperDHT = require('../..')
const HyperDHT6331 = require('hyperdht-6-33-1')
const Holepuncher = require('../../lib/holepuncher')
const { swarm } = require('../helpers')

test(
  'mixed-version fast-open - current initiator falls back to 6.33.1 responder after LAN miss',
  { timeout: 30000 },
  async function (t) {
    const { initiator, responder } = await setupMixedPair(t, HyperDHT, HyperDHT6331)
    const ping = initiator.ping
    const openSession = Holepuncher.prototype.openSession
    const peerHolepunch = initiator._router.peerHolepunch
    const receivedByServer = defer()
    const receivedByClient = defer()
    let lanAttempts = 0
    let openSessions = 0
    let probesBeforeFirstControl = null
    let coordinatedFallback = false

    const server = responder.createServer(function (socket) {
      socket.on('error', receivedByServer.reject)
      socket.once('data', function (data) {
        receivedByServer.resolve(data)
        socket.write('old-server-to-current')
      })
    })

    await server.listen()

    const responderPort = responder.io.serverSocket.address().port

    // Make the advertised LAN route fail so the normal mixed-version
    // holepunch path has to complete the connection.
    initiator.ping = function (addr, ...args) {
      if (addr.port === responderPort) {
        lanAttempts++
        return Promise.reject(new Error('forced LAN miss'))
      }
      return ping.call(this, addr, ...args)
    }

    Holepuncher.prototype.openSession = function (...args) {
      if (this.dht === initiator) openSessions++
      return openSession.apply(this, args)
    }

    initiator._router.peerHolepunch = function (...args) {
      if (probesBeforeFirstControl === null) probesBeforeFirstControl = openSessions
      return peerHolepunch.apply(this, args)
    }

    t.teardown(
      () => {
        initiator.ping = ping
        Holepuncher.prototype.openSession = openSession
        initiator._router.peerHolepunch = peerHolepunch
      },
      { force: true, order: -1 }
    )

    const socket = initiator.connect(server.publicKey, {
      holepunch() {
        coordinatedFallback = true
        return true
      }
    })

    t.teardown(() => socket.destroy(), { force: true })

    socket.on('error', receivedByClient.reject)
    socket.once('data', receivedByClient.resolve)
    socket.write('current-to-old-server')

    const [serverData, clientData] = await Promise.all([
      receivedByServer.promise,
      receivedByClient.promise
    ])

    t.ok(lanAttempts > 0, 'initiator tried the advertised LAN route')
    t.is(probesBeforeFirstControl, 0, 'initiator skipped the speculative probe')
    t.ok(coordinatedFallback, 'initiator fell back to coordinated holepunching')
    t.alike(serverData, Buffer.from('current-to-old-server'), 'old responder received client data')
    t.alike(clientData, Buffer.from('old-server-to-current'), 'current initiator received reply')
  }
)

test(
  'mixed-version fast-open - reordered 6.33.1 probe connects after responder accepts',
  { timeout: 30000 },
  async function (t) {
    const { initiator, responder } = await setupMixedPair(t, HyperDHT6331, HyperDHT)
    const reorderedProbe = reorderInitialProbe(t, initiator, responder)
    const receivedByServer = defer()
    const receivedByClient = defer()

    const server = responder.createServer(
      {
        shareLocalAddress: false,
        holepunch() {
          return true
        }
      },
      function (socket) {
        socket.on('error', receivedByServer.reject)
        socket.once('data', function (data) {
          receivedByServer.resolve(data)
          socket.write('current-server-to-old')
        })
      }
    )

    await server.listen()

    const socket = initiator.connect(server.publicKey, { localConnection: false })

    t.teardown(() => socket.destroy(), { force: true })

    socket.on('error', receivedByClient.reject)
    socket.once('data', receivedByClient.resolve)
    socket.write('old-to-current-server')

    const [window, serverData, clientData] = await Promise.all([
      reorderedProbe,
      receivedByServer.promise,
      receivedByClient.promise
    ])

    t.alike(
      window,
      { remote: true, local: false, echoed: false },
      'delayed probe was ignored before local punching started'
    )
    t.alike(serverData, Buffer.from('old-to-current-server'), 'current responder received data')
    t.alike(clientData, Buffer.from('current-server-to-old'), 'old initiator received reply')
  }
)

test(
  'mixed-version fast-open - reordered 6.33.1 probe cannot bypass responder rejection',
  { timeout: 30000 },
  async function (t) {
    const { initiator, responder } = await setupMixedPair(t, HyperDHT6331, HyperDHT)
    const reorderedProbe = reorderInitialProbe(t, initiator, responder)
    const serverRejected = defer()
    let serverConnected = false

    const server = responder.createServer(
      {
        shareLocalAddress: false,
        holepunch() {
          serverRejected.resolve()
          return false
        }
      },
      function (socket) {
        serverConnected = true
        socket.on('error', () => {})
        socket.destroy()
      }
    )

    await server.listen()

    const outcome = defer()
    const socket = initiator.connect(server.publicKey, { localConnection: false })

    t.teardown(() => socket.destroy(), { force: true })

    socket.once('open', () => {
      outcome.resolve({ event: 'open' })
    })
    socket.once('error', (err) => {
      outcome.resolve({ event: 'error', code: err.code })
    })

    const [window, , result] = await Promise.all([
      reorderedProbe,
      serverRejected.promise,
      outcome.promise
    ])

    t.alike(
      window,
      { remote: true, local: false, echoed: false },
      'peer intent alone does not enable responder echoes'
    )
    t.alike(
      result,
      { event: 'error', code: 'HOLEPUNCH_ABORTED' },
      'rejected holepunch does not false-open the old client'
    )
    t.is(serverConnected, false, 'server did not accept a connection')
  }
)

async function setupMixedPair(t, Initiator, Responder) {
  const { bootstrap } = await swarm(t, 5)
  const responder = new Responder({
    bootstrap,
    host: '127.0.0.1',
    quickFirewall: false,
    ephemeral: true
  })
  const initiator = new Initiator({
    bootstrap,
    host: '127.0.0.1',
    quickFirewall: false,
    ephemeral: true
  })

  t.teardown(() => Promise.allSettled([responder.destroy(), initiator.destroy()]), {
    force: true,
    order: 1
  })

  await Promise.all([responder.fullyBootstrapped(), initiator.fullyBootstrapped()])

  return { initiator, responder }
}

function reorderInitialProbe(t, initiator, responder) {
  const onholepunchmessage = Holepuncher.prototype._onholepunchmessage
  const updateRemote = Holepuncher.prototype.updateRemote
  const ping = Holepuncher.prototype.ping
  const peerHolepunch = initiator._router.peerHolepunch
  const probeHeld = defer()
  const probeReleased = defer()
  let held = null
  let released = false

  Holepuncher.prototype._onholepunchmessage = function (...args) {
    if (this.dht !== responder || this.isInitiator || this.remoteHolepunching || held !== null) {
      return onholepunchmessage.apply(this, args)
    }

    held = { puncher: this, args }
    probeHeld.resolve()
  }

  Holepuncher.prototype.updateRemote = function (state) {
    const result = updateRemote.call(this, state)

    if (
      this.dht !== responder ||
      this.isInitiator ||
      !state.punching ||
      held === null ||
      released
    ) {
      return result
    }

    released = true

    const delayed = held
    const ref = delayed.args[2]
    const send = ref.socket.send
    const hadOwnSend = Object.hasOwn(ref.socket, 'send')
    let echoed = false

    held = null
    ref.socket.send = function (...args) {
      echoed = true
      return send.apply(this, args)
    }

    try {
      onholepunchmessage.apply(delayed.puncher, delayed.args)
    } finally {
      if (hadOwnSend) ref.socket.send = send
      else delete ref.socket.send

      probeReleased.resolve({
        remote: delayed.puncher.remoteHolepunching,
        local: delayed.puncher.punching,
        echoed
      })
    }

    return result
  }

  // Isolate the reordered probe from intentional analyzed server fast-open.
  Holepuncher.prototype.ping = function (...args) {
    if (this.dht === responder) return Promise.resolve()
    return ping.apply(this, args)
  }

  // Ensure the initial UDP probe is held before its control request proceeds.
  initiator._router.peerHolepunch = async function (...args) {
    await probeHeld.promise
    return peerHolepunch.apply(this, args)
  }

  t.teardown(
    () => {
      probeHeld.resolve()
      probeReleased.resolve(null)
      Holepuncher.prototype._onholepunchmessage = onholepunchmessage
      Holepuncher.prototype.updateRemote = updateRemote
      Holepuncher.prototype.ping = ping
      initiator._router.peerHolepunch = peerHolepunch
    },
    { force: true, order: -1 }
  )

  return probeReleased.promise
}

function defer() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
