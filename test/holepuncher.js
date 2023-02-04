const test = require('brittle')
const Holepuncher = require('../lib/holepuncher.js')

test('holepuncher match local address', async function (t) {
  t.is(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    []
  ), null, 'Nothing to match against')

  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '172.16.1.1' }, { host: '10.0.0.5' }]
  ), { host: '172.16.1.1' }, 'First address if no match at all')

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

  /* t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '192.168.122.238' }, { host: '172.16.1.1' }]
  ), { host: '192.168.122.238' }, 'Full match') */
})

test('holepuncher match - with docker installed', async function (t) {
  // Server
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
    [{ host: '192.168.122.238' }, { host: '172.17.0.1' }],
    true
  ), { host: '192.168.122.238' })

  // Client
  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }, { host: '172.17.0.1' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.17.0.1' }],
    false
  ), { host: '192.168.122.1' })
})
