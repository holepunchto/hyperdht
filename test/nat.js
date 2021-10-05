const test = require('brittle')
const Nat = require('../lib/nat')
const { FIREWALL } = require('../lib/constants')

test('firewall - open', function (t) {
  const nat = new Nat({ firewalled: false }, null)

  t.is(nat.sampled, 0)
  t.is(nat.firewall, FIREWALL.OPEN)
})

test('firewall - random', function (t) {
  const nat = new Nat({ firewalled: true }, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8080 })
  t.is(nat.sampled, 1)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8080 })
  t.is(nat.sampled, 1, 'only one sample per referrer')
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8081 }, { host: '127.0.0.1', port: 8081 })
  t.is(nat.sampled, 2)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8082 }, { host: '127.0.0.1', port: 8082 })
  t.is(nat.sampled, 3)
  t.is(nat.firewall, FIREWALL.RANDOM)
  t.alike(nat.addresses, [{ host: '127.0.0.1', port: 0, hits: 3 }])
})

test('firewall - consistent', function (t) {
  const nat = new Nat({ firewalled: true }, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8080 })
  t.is(nat.sampled, 1)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8081 })
  t.is(nat.sampled, 2)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8082 })
  t.is(nat.sampled, 3)
  t.is(nat.firewall, FIREWALL.CONSISTENT)
  t.alike(nat.addresses, [{ host: '127.0.0.1', port: 8080, hits: 3 }])
})

test('firewall - consistent with another sample', function (t) {
  const nat = new Nat({ firewalled: true }, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8080 })
  t.is(nat.sampled, 1)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8081 }, { host: '127.0.0.1', port: 8081 })
  t.is(nat.sampled, 2)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8082 })
  t.is(nat.sampled, 3)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8083 })
  t.is(nat.sampled, 4)
  t.is(nat.firewall, FIREWALL.CONSISTENT)
  t.alike(nat.addresses, [{ host: '127.0.0.1', port: 8080, hits: 3 }, { host: '127.0.0.1', port: 8081, hits: 1 }])
})

test('firewall - double consistent', function (t) {
  const nat = new Nat({ firewalled: true }, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8080 })
  t.is(nat.sampled, 1)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.2', port: 8081 }, { host: '127.0.0.1', port: 8081 })
  t.is(nat.sampled, 2)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8082 })
  t.is(nat.sampled, 3)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.2', port: 8081 }, { host: '127.0.0.1', port: 8083 })
  t.is(nat.sampled, 4)
  t.is(nat.firewall, FIREWALL.CONSISTENT)
  t.alike(nat.addresses, [{ host: '127.0.0.1', port: 8080, hits: 2 }, { host: '127.0.0.2', port: 8081, hits: 2 }])
})

test('firewall - not quite consistent', function (t) {
  const nat = new Nat({ firewalled: true }, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8080 })
  t.is(nat.sampled, 1)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8080 }, { host: '127.0.0.1', port: 8081 })
  t.is(nat.sampled, 2)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8081 }, { host: '127.0.0.1', port: 8082 })
  t.is(nat.sampled, 3)
  t.is(nat.firewall, FIREWALL.UNKNOWN)
  t.is(nat.addresses, null)

  nat.add({ host: '127.0.0.1', port: 8082 }, { host: '127.0.0.1', port: 8083 })
  t.is(nat.sampled, 4)
  t.is(nat.firewall, FIREWALL.RANDOM)
  t.alike(nat.addresses, [{ host: '127.0.0.1', port: 0, hits: 4 }])
})
