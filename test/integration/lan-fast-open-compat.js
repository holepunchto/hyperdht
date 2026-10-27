const test = require('brittle')
const HyperDHT = require('../..')
const HyperDHT6331 = require('hyperdht-6-33-1')
const Holepuncher = require('../../lib/holepuncher')
const Holepuncher6331 = require('hyperdht-6-33-1/lib/holepuncher')
const { swarm } = require('../helpers')

test('LAN fast-open policy - current initiator and 6.33.1 responder', async function (t) {
  const { initiator, responder, server, resumeLan, triedLan } = await setup(
    t,
    HyperDHT,
    HyperDHT6331
  )
  const openSession = Holepuncher.prototype.openSession
  const onholepunchmessage6331 = Holepuncher6331.prototype._onholepunchmessage
  const peerHolepunch = initiator._router.peerHolepunch
  const continueHolepunch = defer()
  const probeEchoed = defer()
  const routeReady = defer()
  let sentProbe = false
  let earlyEcho = false

  Holepuncher.prototype.openSession = function (...args) {
    if (this.dht === initiator) sentProbe = true
    return openSession.apply(this, args)
  }

  Holepuncher6331.prototype._onholepunchmessage = function (...args) {
    if (this.dht !== responder || this.isInitiator || this.remoteHolepunching || earlyEcho) {
      return onholepunchmessage6331.apply(this, args)
    }

    const ref = args[2]
    const send = ref.socket.send
    const hadOwnSend = Object.hasOwn(ref.socket, 'send')

    ref.socket.send = function (...sendArgs) {
      earlyEcho = true
      probeEchoed.resolve()
      return send.apply(this, sendArgs)
    }

    try {
      return onholepunchmessage6331.apply(this, args)
    } finally {
      if (hadOwnSend) ref.socket.send = send
      else delete ref.socket.send
    }
  }

  initiator._router.peerHolepunch = async function (...args) {
    if (sentProbe) await probeEchoed.promise
    resumeLan()
    routeReady.resolve(earlyEcho)
    await continueHolepunch.promise
    return peerHolepunch.apply(this, args)
  }

  t.teardown(
    () => {
      resumeLan()
      continueHolepunch.resolve()
      probeEchoed.resolve()
      routeReady.resolve(false)
      Holepuncher.prototype.openSession = openSession
      Holepuncher6331.prototype._onholepunchmessage = onholepunchmessage6331
      initiator._router.peerHolepunch = peerHolepunch
    },
    { force: true, order: -1 }
  )

  const socket = initiator.connect(server.publicKey)
  socket.on('error', () => {})

  const echoed = await routeReady.promise
  t.ok(triedLan(), 'initiator started the LAN attempt')
  t.is(echoed, false, 'initiator skipped the initial probe')
  socket.destroy()
  continueHolepunch.resolve()
})

test('LAN fast-open policy - 6.33.1 initiator and current responder', async function (t) {
  const { initiator, responder, server, resumeLan, triedLan } = await setup(
    t,
    HyperDHT6331,
    HyperDHT
  )
  const onholepunchmessage = Holepuncher.prototype._onholepunchmessage
  const peerHolepunch = initiator._router.peerHolepunch
  const continueHolepunch = defer()
  const probeHandled = defer()
  let receivedProbe = false
  let earlyEcho = false

  // Keep LAN pending until the responder decides whether the initial probe
  // should be echoed. A premature echo can otherwise win the client race.
  Holepuncher.prototype._onholepunchmessage = function (...args) {
    if (this.dht !== responder || this.isInitiator || this.remoteHolepunching || receivedProbe) {
      return onholepunchmessage.apply(this, args)
    }

    receivedProbe = true
    const ref = args[2]
    const send = ref.socket.send
    const hadOwnSend = Object.hasOwn(ref.socket, 'send')

    ref.socket.send = function (...sendArgs) {
      earlyEcho = true
      return send.apply(this, sendArgs)
    }

    try {
      return onholepunchmessage.apply(this, args)
    } finally {
      if (hadOwnSend) ref.socket.send = send
      else delete ref.socket.send
      resumeLan()
      probeHandled.resolve(earlyEcho)
    }
  }

  initiator._router.peerHolepunch = async function (...args) {
    await continueHolepunch.promise
    return peerHolepunch.apply(this, args)
  }

  t.teardown(
    () => {
      resumeLan()
      continueHolepunch.resolve()
      probeHandled.resolve(false)
      Holepuncher.prototype._onholepunchmessage = onholepunchmessage
      initiator._router.peerHolepunch = peerHolepunch
    },
    { force: true, order: -1 }
  )

  const socket = initiator.connect(server.publicKey)
  socket.on('error', () => {})

  const echoed = await probeHandled.promise
  t.ok(triedLan(), 'initiator started the LAN attempt')
  t.is(echoed, false, 'responder skipped the initial echo')
  socket.destroy()
  continueHolepunch.resolve()
})

async function setup(t, Initiator, Responder) {
  const { bootstrap } = await swarm(t, 3)
  const responder = new Responder({ bootstrap })
  const initiator = new Initiator({ bootstrap, host: '127.0.0.1' })
  const server = responder.createServer()

  await server.listen()

  const ping = initiator.ping
  const responderPort = responder.io.serverSocket.address().port
  const lanReady = defer()
  let startedLan = false

  initiator.ping = async function (addr, ...args) {
    if (addr.port === responderPort) {
      startedLan = true
      await lanReady.promise
    }
    return ping.call(this, addr, ...args)
  }

  t.teardown(
    async () => {
      lanReady.resolve()
      initiator.ping = ping
      await Promise.all([responder.destroy(), initiator.destroy()])
    },
    { force: true, order: 1 }
  )

  return {
    initiator,
    responder,
    server,
    resumeLan: lanReady.resolve,
    triedLan: () => startedLan
  }
}

function defer() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
