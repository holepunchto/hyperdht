const test = require('brittle')
const Holepuncher = require('../lib/holepuncher.js')

test('holepuncher match - nothing to match', async function (t) {
  t.is(Holepuncher.matchAddress(
    [],
    []
  ), null)

  t.is(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    []
  ), null)
})

test('holepuncher match - two different processes', async function (t) {
  // Host
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }]
  ), { host: '192.168.0.23' })

  // Virtual machine
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '192.168.122.238' }]
  ), { host: '192.168.122.238' })

  // Docker
  t.alike(Holepuncher.matchAddress(
    [{ host: '172.17.0.2' }],
    [{ host: '172.17.0.2' }]
  ), { host: '172.17.0.2' })

  // DigitalOcean
  t.alike(Holepuncher.matchAddress(
    [{ host: '67.205.156.23' }, { host: '10.10.0.6' }, { host: '10.116.0.3' }],
    [{ host: '10.10.0.6' }, { host: '10.116.0.3' }]
  ), { host: '10.10.0.6' })

  // Only localhost
  t.alike(Holepuncher.matchAddress(
    [{ host: '127.0.0.1' }],
    [{ host: '127.0.0.1' }]
  ), { host: '127.0.0.1' })
})

test('holepuncher match - host vs virtual machine', async function (t) {
  // (host without docker, vm without docker)
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }],
    [{ host: '192.168.122.238' }]
  ), { host: '192.168.122.238' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }]
  ), { host: '192.168.122.1' })

  // (host without docker, vm with docker)
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }],
    [{ host: '192.168.122.238' }, { host: '172.17.0.1' }]
  ), { host: '192.168.122.238' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }, { host: '172.17.0.1' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }]
  ), { host: '192.168.122.1' })

  // (host with docker, vm without docker)
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
    [{ host: '192.168.122.238' }, { host: '172.17.0.1' }]
  ), { host: '192.168.122.238' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }, { host: '172.17.0.1' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }]
  ), { host: '192.168.122.1' })

  // (host with docker, vm with docker)
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
    [{ host: '192.168.122.238' }]
  ), { host: '192.168.122.238' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }]
  ), { host: '192.168.122.1' })
})

test('holepuncher match - host vs container', async function (t) {
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
    [{ host: '172.17.0.2' }]
  ), { host: '172.17.0.2' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '172.17.0.2' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }]
  ), { host: '172.17.0.1' })
})

test('holepuncher match - container vs container (on same host)', async function (t) {
  t.alike(Holepuncher.matchAddress(
    [{ host: '172.17.0.3' }],
    [{ host: '172.17.0.2' }]
  ), { host: '172.17.0.2' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '172.17.0.2' }],
    [{ host: '172.17.0.3' }]
  ), { host: '172.17.0.3' })
})

test.skip('holepuncher match - container on host vs container on virtual machine', async function (t) {})

test.skip('holepuncher match - host vs container on virtual machine', async function (t) {})
test.skip('holepuncher match - container on host vs virtual machine', async function (t) {})

test('holepuncher match - custom made', async function (t) {
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '172.16.1.1' }, { host: '10.0.0.5' }]
  ), { host: '172.16.1.1' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '10.1.2.3' }],
    [{ host: '192.168.0.23' }, { host: '172.16.1.1' }, { host: '10.4.5.6' }, { host: '192.168.122.1' }]
  ), { host: '10.4.5.6' }, 'Same network (first segment)')

  t.alike(Holepuncher.matchAddress(
    [{ host: '10.0.2.3' }],
    [{ host: '192.168.0.23' }, { host: '172.16.1.1' }, { host: '10.4.5.6' }, { host: '10.0.5.6' }, { host: '192.168.122.1' }]
  ), { host: '10.0.5.6' }, 'Same network (second segment)')

  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.16.1.1' }]
  ), { host: '192.168.122.1' }, 'Same subnet (third segment)')
})
