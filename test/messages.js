const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const m = require('../lib/messages')
const { MAX_WIRE_ARRAY_LENGTH } = require('../lib/constants')

test('basic noise payload', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const c = {
    version: 1,
    error: 0,
    firewall: 0,
    holepunch: null,
    addresses4: [],
    addresses6: [],
    udx: null,
    secretStream: null,
    relayThrough: null,
    relayAddresses: null
  }

  m.noisePayload.preencode(state, c)

  t.is(state.end, 4)

  state.buffer = b4a.allocUnsafe(state.end)
  m.noisePayload.encode(state, c)

  t.is(state.start, 4)

  state.start = 0

  const d = m.noisePayload.decode(state)

  t.alike(d, c)
})

test('noise payload with holepunch and addresses', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const c = {
    version: 1,
    error: 0,
    firewall: 2,
    holepunch: {
      id: 10,
      relays: [
        {
          peerAddress: { host: '1.2.3.4', port: 1425 },
          relayAddress: { host: '4.56.2.1', port: 4244 }
        }
      ]
    },
    addresses4: [
      {
        host: '127.0.0.1',
        port: 10240
      }
    ],
    addresses6: [],
    udx: null,
    secretStream: null,
    relayThrough: null,
    relayAddresses: null
  }

  m.noisePayload.preencode(state, c)

  state.buffer = b4a.allocUnsafe(state.end)
  m.noisePayload.encode(state, c)

  state.start = 0

  const d = m.noisePayload.decode(state)

  t.is(state.start, state.end)
  t.alike(d, c)
})

test('noise payload with relayAddresses', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const c = {
    version: 1,
    error: 0,
    firewall: 2,
    holepunch: null,
    addresses4: [],
    addresses6: [],
    udx: null,
    secretStream: null,
    relayThrough: null,
    relayAddresses: [
      {
        host: '127.0.0.1',
        port: 10240
      }
    ]
  }

  m.noisePayload.preencode(state, c)

  state.buffer = b4a.allocUnsafe(state.end)
  m.noisePayload.encode(state, c)

  state.start = 0

  const d = m.noisePayload.decode(state)

  t.is(state.start, state.end)
  t.alike(d, c)
})

test('noise payload only addresses', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const c = {
    version: 1,
    error: 0,
    firewall: 2,
    holepunch: null,
    addresses4: [
      {
        host: '127.0.0.1',
        port: 10241
      }
    ],
    addresses6: [],
    udx: null,
    secretStream: null,
    relayThrough: null,
    relayAddresses: null
  }

  m.noisePayload.preencode(state, c)

  state.buffer = b4a.allocUnsafe(state.end)
  m.noisePayload.encode(state, c)

  state.start = 0

  const d = m.noisePayload.decode(state)

  t.is(state.start, state.end)
  t.alike(d, c)
})

test('noise payload ipv6', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const c = {
    version: 1,
    error: 0,
    firewall: 2,
    holepunch: null,
    addresses4: [],
    addresses6: [
      {
        host: '0:0:0:0:0:0:0:1',
        port: 42420
      }
    ],
    udx: null,
    secretStream: null,
    relayThrough: null,
    relayAddresses: null
  }

  m.noisePayload.preencode(state, c)

  state.buffer = b4a.allocUnsafe(state.end)
  m.noisePayload.encode(state, c)

  state.start = 0

  const d = m.noisePayload.decode(state)

  t.is(state.start, state.end)
  t.alike(d, c)
})

test('noise payload newer version', function (t) {
  // version 2 with some "version specific" data
  const newer = Buffer.from([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  const state = { start: 0, end: newer.byteLength, buffer: newer }

  const d = m.noisePayload.decode(state)

  t.alike(d, {
    version: 2,
    error: 0,
    firewall: 0,
    holepunch: null,
    addresses4: [],
    addresses6: [],
    udx: null,
    secretStream: null,
    relayThrough: null,
    relayAddresses: null
  })
})

test('basic holepunch payload', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const h = {
    error: 0,
    firewall: 0,
    round: 0,
    connected: false,
    punching: false,
    addresses: null,
    remoteAddress: null,
    token: null,
    remoteToken: null
  }

  m.holepunchPayload.preencode(state, h)

  state.buffer = b4a.allocUnsafe(state.end)
  m.holepunchPayload.encode(state, h)

  state.start = 0

  const d = m.holepunchPayload.decode(state)

  t.alike(d, h)
})

test('holepunch payload with flag and addresses', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const h = {
    error: 0,
    firewall: 0,
    round: 1,
    connected: false,
    punching: true,
    addresses: [
      {
        host: '127.0.0.1',
        port: 10241
      }
    ],
    remoteAddress: null,
    token: null,
    remoteToken: null
  }

  m.holepunchPayload.preencode(state, h)

  state.buffer = b4a.allocUnsafe(state.end)
  m.holepunchPayload.encode(state, h)

  state.start = 0

  const d = m.holepunchPayload.decode(state)

  t.alike(d, h)
})

test('holepunch payload with flag and remoteToken', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const h = {
    error: 0,
    firewall: 0,
    round: 0,
    connected: false,
    punching: true,
    addresses: null,
    remoteAddress: null,
    token: null,
    remoteToken: Buffer.alloc(32).fill('remote-token')
  }

  m.holepunchPayload.preencode(state, h)

  state.buffer = b4a.allocUnsafe(state.end)
  m.holepunchPayload.encode(state, h)

  state.start = 0

  const d = m.holepunchPayload.decode(state)

  t.alike(d, h)
})

test('peer with no relays', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const peer = { publicKey: Buffer.alloc(32).fill('pk'), relayAddresses: [] }

  m.peer.preencode(state, peer)
  state.buffer = b4a.allocUnsafe(state.end)
  m.peer.encode(state, peer)

  t.is(state.end, state.start, 'fully encoded')

  state.start = 0
  const d = m.peer.decode(state)

  t.alike(d, peer)
})

test('peer with multiple relays', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const peer = {
    publicKey: Buffer.alloc(32).fill('abc'),
    relayAddresses: [
      {
        host: '127.0.0.1',
        port: 4242
      },
      {
        host: '8.1.4.1',
        port: 402
      }
    ]
  }

  m.peer.preencode(state, peer)
  state.buffer = b4a.allocUnsafe(state.end)
  m.peer.encode(state, peer)

  t.is(state.end, state.start, 'fully encoded')

  state.start = 0
  const d = m.peer.decode(state)

  t.alike(d, peer)
})

test('peers', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const peers = [
    {
      publicKey: Buffer.alloc(32).fill('abc'),
      relayAddresses: [
        {
          host: '127.0.0.1',
          port: 4242
        },
        {
          host: '8.1.4.1',
          port: 402
        }
      ]
    },
    {
      publicKey: Buffer.alloc(32).fill('another'),
      relayAddresses: []
    }
  ]

  m.peers.preencode(state, peers)
  state.buffer = b4a.allocUnsafe(state.end)
  m.peers.encode(state, peers)

  t.is(state.end, state.start, 'fully encoded')

  state.start = 0
  const d = m.peers.decode(state)

  t.alike(d, peers)
})

test('announce', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const ann = {
    peer: {
      publicKey: Buffer.alloc(32).fill('abc'),
      relayAddresses: []
    },
    refresh: null,
    signature: null,
    bump: 0
  }

  m.announce.preencode(state, ann)
  state.buffer = b4a.allocUnsafe(state.end)
  m.announce.encode(state, ann)

  t.is(state.end, state.start, 'fully encoded')

  state.start = 0
  const d = m.announce.decode(state)

  t.alike(d, ann)
})

test('announce with signature', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const ann = {
    peer: {
      publicKey: Buffer.alloc(32).fill('abc'),
      relayAddresses: []
    },
    refresh: null,
    signature: Buffer.alloc(64).fill('signature'),
    bump: 0
  }

  m.announce.preencode(state, ann)
  state.buffer = b4a.allocUnsafe(state.end)
  m.announce.encode(state, ann)

  t.is(state.end, state.start, 'fully encoded')

  state.start = 0
  const d = m.announce.decode(state)

  t.alike(d, ann)
})

test('announce with refresh', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const ann = {
    peer: {
      publicKey: Buffer.alloc(32).fill('abc'),
      relayAddresses: []
    },
    refresh: Buffer.alloc(32).fill('refresh'),
    signature: null,
    bump: 0
  }

  m.announce.preencode(state, ann)
  state.buffer = b4a.allocUnsafe(state.end)
  m.announce.encode(state, ann)

  t.is(state.end, state.start, 'fully encoded')

  state.start = 0
  const d = m.announce.decode(state)

  t.alike(d, ann)
})

test('wire arrays allow entries up to the cap', function (t) {
  const relayAddresses = []
  for (let i = 0; i < MAX_WIRE_ARRAY_LENGTH; i++) {
    relayAddresses.push({ host: '127.0.0.1', port: 1000 + i })
  }

  const peer = { publicKey: Buffer.alloc(32).fill('pk'), relayAddresses }
  const state = { start: 0, end: 0, buffer: null }

  m.peer.preencode(state, peer)
  state.buffer = b4a.allocUnsafe(state.end)
  m.peer.encode(state, peer)

  state.start = 0
  t.alike(m.peer.decode(state), peer, 'cap entries roundtrip')

  relayAddresses.push({ host: '127.0.0.1', port: 9999 })

  const over = { start: 0, end: 0, buffer: null }
  m.peer.preencode(over, peer)
  over.buffer = b4a.allocUnsafe(over.end)
  m.peer.encode(over, peer)

  over.start = 0
  t.exception(() => m.peer.decode(over), /Array is too big/, 'cap + 1 entries on the wire throws')
})

test('crafted array length prefixes throw before allocating', function (t) {
  // a peer record whose relayAddresses claims ~1M entries
  const evilPeer = b4a.concat([b4a.alloc(32), c.encode(c.uint, 0x100000)])

  t.exception(() => {
    const state = { start: 0, end: evilPeer.byteLength, buffer: evilPeer }
    m.peer.decode(state)
  }, /Array is too big/)

  // a noise payload with the addresses4 flag set and ~1M claimed entries
  const evilPayload = b4a.concat([
    c.encode(c.uint, 1), // version
    c.encode(c.uint, 2), // flags = addresses4
    c.encode(c.uint, 0), // error
    c.encode(c.uint, 0), // firewall
    c.encode(c.uint, 0x100000)
  ])

  t.exception(() => {
    const state = { start: 0, end: evilPayload.byteLength, buffer: evilPayload }
    m.noisePayload.decode(state)
  }, /Array is too big/)
})
