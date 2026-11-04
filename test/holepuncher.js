const test = require('brittle')
const b4a = require('b4a')
const Holepuncher = require('../lib/holepuncher.js')
const { FIREWALL } = require('../lib/constants.js')

const PROBE = b4a.from([0])
const FAST_OPEN = b4a.from([1])

test('holepuncher initiator only accepts fast-open before punching', function (t) {
  const { puncher, ref, addr, connects } = createHolepuncher(true)

  puncher._onholepunchmessage(PROBE, addr, ref)
  t.is(connects.length, 0, 'probe echo ignored')

  puncher._onholepunchmessage(FAST_OPEN, addr, ref)
  t.alike(connects, [addr], 'fast-open connects')

  puncher.destroy()
})

test('holepuncher initiator accepts probe echoes while punching', function (t) {
  const { puncher, ref, addr, connects } = createHolepuncher(true)

  puncher.punching = true
  puncher._onholepunchmessage(PROBE, addr, ref)
  t.alike(connects, [addr])

  puncher.destroy()
})

test('holepuncher responder only echoes after local punching starts', function (t) {
  const { puncher, ref, addr, sent } = createHolepuncher(false)

  puncher.updateRemote({ punching: true })
  puncher._onholepunchmessage(PROBE, addr, ref)
  t.is(sent.length, 0, 'remote punching alone does not echo')

  puncher.punching = true
  puncher._onholepunchmessage(PROBE, addr, ref)
  t.is(sent.length, 1, 'echoes once punching')

  puncher.destroy()
})

test('holepuncher punch only marks punching when a strategy starts', async function (t) {
  const { CONSISTENT, RANDOM } = FIREWALL
  const cases = [
    [CONSISTENT, CONSISTENT, null, true],
    [CONSISTENT, RANDOM, '127.0.0.1', true],
    [RANDOM, CONSISTENT, '127.0.0.1', true],
    [CONSISTENT, RANDOM, null, false],
    [RANDOM, RANDOM, '127.0.0.1', false]
  ]

  for (const [local, remote, verified, punching] of cases) {
    const { puncher } = createHolepuncher(false)

    puncher.nat.firewall = local
    puncher.updateRemote({
      punching: true,
      firewall: remote,
      addresses: [{ host: '127.0.0.1', port: 4321 }],
      verified
    })

    t.is(await puncher.punch(), punching)
    t.is(puncher.punching, punching)

    puncher.destroy()
  }
})

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

function createHolepuncher(isInitiator) {
  const sent = []
  const connects = []
  const socket = {
    send(message) {
      sent.push(message)
      return Promise.resolve()
    }
  }
  const ref = { socket, release() {} }
  const dht = {
    firewalled: false,
    nodes: { length: 0, latest: null },
    stats: { punches: { consistent: 0, random: 0 } },
    _randomPunches: 0,
    _socketPool: { acquire: () => ref }
  }
  const puncher = new Holepuncher(dht, {}, isInitiator)

  puncher.onconnect = (_, port, host) => connects.push({ host, port })

  return { puncher, ref, sent, connects, addr: { host: '127.0.0.1', port: 1234 } }
}
