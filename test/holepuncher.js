const test = require('brittle')
const Holepuncher = require('../lib/holepuncher.js')

test('holepuncher match local address', async function (t) {
  t.is(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    []
  ), null)

  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '172.16.1.1' }, { host: '10.0.0.5' }]
  ), { host: '172.16.1.1' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '172.16.1.1' }]
  ), { host: '192.168.122.1' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '192.168.122.238' }],
    [{ host: '192.168.0.23' }, { host: '192.168.122.1' }, { host: '192.168.122.238' }, { host: '172.16.1.1' }]
  ), { host: '192.168.122.238' })

  t.alike(Holepuncher.matchAddress(
    [{ host: '10.1.2.3' }],
    [{ host: '192.168.0.23' }, { host: '172.16.1.1' }, { host: '10.4.5.6' }, { host: '192.168.122.1' }, { host: '192.168.122.238' }]
  ), { host: '10.4.5.6' })
})
