const test = require('brittle')
const b4a = require('b4a')
const Holepuncher = require('../lib/holepuncher.js')
const { FIREWALL } = require('../lib/constants.js')

test('holepuncher distinguishes probe echoes from fast-open', function (t) {
  const probe = createInitiator()
  probe.puncher._onholepunchmessage(b4a.from([0]), probe.address, probe.ref)
  t.is(probe.puncher.connected, false, 'probe echo does not connect before punching')
  probe.puncher.destroy()

  const fastOpen = createInitiator()
  fastOpen.puncher._onholepunchmessage(b4a.from([1]), fastOpen.address, fastOpen.ref)
  t.is(fastOpen.puncher.connected, true, 'explicit fast-open connects before punching')
  t.alike(fastOpen.connected, fastOpen.address, 'fast-open selects the responding address')
  fastOpen.puncher.destroy()

  const punching = createInitiator()
  punching.puncher.punching = true
  punching.puncher._onholepunchmessage(b4a.from([0]), punching.address, punching.ref)
  t.is(punching.puncher.connected, true, 'probe echo connects while punching')
  t.alike(punching.connected, punching.address, 'punching selects the responding address')
  punching.puncher.destroy()
})

test('holepuncher only echoes after local punching starts', function (t) {
  const responder = createHolepuncher(false)

  responder.puncher._onholepunchmessage(b4a.from([0]), responder.address, responder.ref)
  t.is(responder.sent.length, 0, 'uncommitted probe is not echoed')

  responder.puncher.updateRemote({ punching: true })
  responder.puncher._onholepunchmessage(b4a.from([0]), responder.address, responder.ref)
  t.is(responder.sent.length, 0, 'peer intent alone does not enable echoes')

  responder.puncher.punching = true
  responder.puncher._onholepunchmessage(b4a.from([0]), responder.address, responder.ref)
  t.is(responder.sent.length, 1, 'echoes after local punching starts')

  responder.puncher.destroy()
})

test('holepuncher punch refusal does not mark punching or echo', async function (t) {
  const responder = createHolepuncher(false)

  responder.puncher.updateRemote({
    punching: true,
    firewall: FIREWALL.RANDOM,
    addresses: [{ host: '127.0.0.1', port: 4321 }],
    verified: null
  })

  t.is(await responder.puncher.punch(), false, 'no verified address refuses to punch')
  t.is(responder.puncher.punching, false, 'refused punch does not mark punching')

  responder.puncher._onholepunchmessage(b4a.from([0]), responder.address, responder.ref)
  t.is(responder.sent.length, 0, 'refused puncher does not echo')

  responder.puncher.destroy()

  const fallthrough = createHolepuncher(false)

  fallthrough.puncher.nat.firewall = FIREWALL.RANDOM
  fallthrough.puncher.updateRemote({
    punching: true,
    firewall: FIREWALL.RANDOM,
    addresses: [{ host: '127.0.0.1', port: 4321 }],
    verified: '127.0.0.1'
  })

  t.is(await fallthrough.puncher.punch(), false, 'double random refuses to punch')
  t.is(fallthrough.puncher.punching, false, 'refused punch does not mark punching')

  fallthrough.puncher.destroy()
})

test('holepuncher punch marks punching for each strategy', async function (t) {
  const consistent = createHolepuncher(false)

  consistent.puncher.updateRemote({
    punching: true,
    firewall: FIREWALL.CONSISTENT,
    addresses: [{ host: '127.0.0.1', port: 4321 }],
    verified: null
  })

  t.is(await consistent.puncher.punch(), true, 'consistent/consistent punches')
  t.is(consistent.puncher.punching, true, 'consistent/consistent marks punching')

  consistent.puncher._onholepunchmessage(b4a.from([0]), consistent.address, consistent.ref)
  t.is(consistent.sent.length, 1, 'punching puncher echoes')

  consistent.puncher.destroy()

  const random = createHolepuncher(false)

  random.puncher.updateRemote({
    punching: true,
    firewall: FIREWALL.RANDOM,
    addresses: [{ host: '127.0.0.1', port: 4321 }],
    verified: '127.0.0.1'
  })

  t.is(await random.puncher.punch(), true, 'consistent/random punches')
  t.is(random.puncher.punching, true, 'consistent/random marks punching')

  random.puncher.destroy()

  const birthday = createHolepuncher(false)

  birthday.puncher.nat.firewall = FIREWALL.RANDOM
  birthday.puncher.updateRemote({
    punching: true,
    firewall: FIREWALL.CONSISTENT,
    addresses: [{ host: '127.0.0.1', port: 4321 }],
    verified: '127.0.0.1'
  })

  t.is(await birthday.puncher.punch(), true, 'random/consistent punches')
  t.is(birthday.puncher.punching, true, 'random/consistent marks punching')

  birthday.puncher.destroy()
})

test('holepuncher fast-open uses supplied socket', async function (t) {
  const held = []
  const sent = []
  const { puncher, address } = createHolepuncher(true, held)

  await puncher.fastOpen(address, createSocket(sent))

  t.alike(held, [], 'held socket is not used')
  t.alike(sent, [
    {
      message: b4a.from([1]),
      port: address.port,
      host: address.host,
      ttl: 64
    }
  ])

  puncher.destroy()
})

function createInitiator() {
  return createHolepuncher(true)
}

function createSocket(sent) {
  return {
    send(message, port, host, ttl) {
      sent.push({ message, port, host, ttl })
      return Promise.resolve()
    }
  }
}

function createHolepuncher(isInitiator, sent = []) {
  const socket = createSocket(sent)
  const ref = { socket, release() {} }
  const dht = {
    firewalled: false,
    nodes: { length: 0, latest: null },
    stats: { punches: { consistent: 0, random: 0, open: 0 } },
    _randomPunches: 0,
    _socketPool: { acquire: () => ref }
  }
  const puncher = new Holepuncher(dht, {}, isInitiator)
  const address = { host: '127.0.0.1', port: 1234 }
  let connected = null

  puncher.onconnect = function (_, port, host) {
    connected = { host, port }
  }

  return {
    puncher,
    ref,
    address,
    sent,
    get connected() {
      return connected
    }
  }
}

test('holepuncher match - nothing to match', async function (t) {
  t.is(Holepuncher.matchAddress([], []), null)

  t.is(Holepuncher.matchAddress([{ host: '192.168.122.238' }], []), null)
})

test('holepuncher match - two different processes', async function (t) {
  // Host
  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }]
    ),
    { host: '192.168.0.23' }
  )

  // Virtual machine
  t.alike(Holepuncher.matchAddress([{ host: '192.168.122.238' }], [{ host: '192.168.122.238' }]), {
    host: '192.168.122.238'
  })

  // Docker
  t.alike(Holepuncher.matchAddress([{ host: '172.17.0.2' }], [{ host: '172.17.0.2' }]), {
    host: '172.17.0.2'
  })

  // DigitalOcean
  t.alike(
    Holepuncher.matchAddress(
      [{ host: '67.205.156.23' }, { host: '10.10.0.6' }, { host: '10.116.0.3' }],
      [{ host: '10.10.0.6' }, { host: '10.116.0.3' }]
    ),
    { host: '10.10.0.6' }
  )

  // Only localhost
  t.alike(Holepuncher.matchAddress([{ host: '127.0.0.1' }], [{ host: '127.0.0.1' }]), {
    host: '127.0.0.1'
  })
})

test('holepuncher match - host vs virtual machine', async function (t) {
  // (host without docker, vm without docker)
  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }],
      [{ host: '192.168.122.238' }]
    ),
    { host: '192.168.122.238' }
  )

  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.122.238' }],
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }]
    ),
    { host: '192.168.122.1' }
  )

  // (host without docker, vm with docker)
  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }],
      [{ host: '192.168.122.238' }, { host: '172.17.0.1' }]
    ),
    { host: '192.168.122.238' }
  )

  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.122.238' }, { host: '172.17.0.1' }],
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }]
    ),
    { host: '192.168.122.1' }
  )

  // (host with docker, vm without docker)
  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
      [{ host: '192.168.122.238' }, { host: '172.17.0.1' }]
    ),
    { host: '192.168.122.238' }
  )

  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.122.238' }, { host: '172.17.0.1' }],
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }]
    ),
    { host: '192.168.122.1' }
  )

  // (host with docker, vm with docker)
  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
      [{ host: '192.168.122.238' }]
    ),
    { host: '192.168.122.238' }
  )

  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.122.238' }],
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }]
    ),
    { host: '192.168.122.1' }
  )
})

test('holepuncher match - host vs container', async function (t) {
  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
      [{ host: '172.17.0.2' }]
    ),
    { host: '172.17.0.2' }
  )

  t.alike(
    Holepuncher.matchAddress(
      [{ host: '172.17.0.2' }],
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }]
    ),
    { host: '172.17.0.1' }
  )
})

test('holepuncher match - container vs container (on same host)', async function (t) {
  t.alike(Holepuncher.matchAddress([{ host: '172.17.0.3' }], [{ host: '172.17.0.2' }]), {
    host: '172.17.0.2'
  })

  t.alike(Holepuncher.matchAddress([{ host: '172.17.0.2' }], [{ host: '172.17.0.3' }]), {
    host: '172.17.0.3'
  })
})

test.skip('holepuncher match - container on host vs container on virtual machine', async function (t) {})

test.skip('holepuncher match - host vs container on virtual machine', async function (t) {})
test.skip('holepuncher match - container on host vs virtual machine', async function (t) {})

test('holepuncher match - custom made', async function (t) {
  t.is(
    Holepuncher.matchAddress(
      [{ host: '192.168.122.238' }],
      [{ host: '172.16.1.1' }, { host: '10.0.0.5' }]
    ),
    null
  )

  t.alike(
    Holepuncher.matchAddress(
      [{ host: '10.1.2.3' }],
      [
        { host: '192.168.0.23' },
        { host: '172.16.1.1' },
        { host: '10.4.5.6' },
        { host: '192.168.122.1' }
      ]
    ),
    { host: '10.4.5.6' },
    'Same network (first segment)'
  )

  t.alike(
    Holepuncher.matchAddress(
      [{ host: '10.0.2.3' }],
      [
        { host: '192.168.0.23' },
        { host: '172.16.1.1' },
        { host: '10.4.5.6' },
        { host: '10.0.5.6' },
        { host: '192.168.122.1' }
      ]
    ),
    { host: '10.0.5.6' },
    'Same network (second segment)'
  )

  t.alike(
    Holepuncher.matchAddress(
      [{ host: '192.168.122.238' }],
      [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.16.1.1' }]
    ),
    { host: '192.168.122.1' },
    'Same subnet (third segment)'
  )
})
