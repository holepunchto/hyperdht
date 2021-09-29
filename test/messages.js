const test = require('brittle')
const m = require('../lib/messages')

test('basic noise payload', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const c = {
    version: 1,
    error: 0,
    firewall: 0,
    protocols: 0,
    holepunch: null,
    addresses: null
  }

  m.noisePayload.preencode(state, c)

  t.is(state.end, 5)

  state.buffer = Buffer.allocUnsafe(state.end)
  m.noisePayload.encode(state, c)

  t.is(state.start, 5)

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
    protocols: 0,
    holepunch: {
      id: 10,
      relays: [
        {
          peerAddress: { id: null, host: '1.2.3.4', port: 1425 },
          relayAddress: { id: null, host: '4.56.2.1', port: 4244 }
        }
      ]
    },
    addresses: [{
      id: null,
      host: '127.0.0.1',
      port: 10240
    }]
  }

  m.noisePayload.preencode(state, c)

  state.buffer = Buffer.allocUnsafe(state.end)
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
    protocols: 0,
    holepunch: null,
    addresses: [{
      id: null,
      host: '127.0.0.1',
      port: 10241
    }]
  }

  m.noisePayload.preencode(state, c)

  state.buffer = Buffer.allocUnsafe(state.end)
  m.noisePayload.encode(state, c)

  state.start = 0

  const d = m.noisePayload.decode(state)

  t.is(state.start, state.end)
  t.alike(d, c)
})

test('basic holepunch payload', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const h = {
    error: 0,
    firewall: 0,
    punching: false,
    address: null,
    remoteAddress: null,
    token: null,
    remoteToken: null
  }

  m.holepunchPayload.preencode(state, h)

  state.buffer = Buffer.allocUnsafe(state.end)
  m.holepunchPayload.encode(state, h)

  state.start = 0

  const d = m.holepunchPayload.decode(state)

  t.alike(d, h)
})

test('holepunch payload with flag and address', function (t) {
  const state = { start: 0, end: 0, buffer: null }

  const h = {
    error: 0,
    firewall: 0,
    punching: true,
    address: {
      id: null,
      host: '127.0.0.1',
      port: 10241
    },
    remoteAddress: null,
    token: null,
    remoteToken: null
  }

  m.holepunchPayload.preencode(state, h)

  state.buffer = Buffer.allocUnsafe(state.end)
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
    punching: true,
    address: null,
    remoteAddress: null,
    token: null,
    remoteToken: Buffer.alloc(32).fill('remote-token')
  }

  m.holepunchPayload.preencode(state, h)

  state.buffer = Buffer.allocUnsafe(state.end)
  m.holepunchPayload.encode(state, h)

  state.start = 0

  const d = m.holepunchPayload.decode(state)

  t.alike(d, h)
})
