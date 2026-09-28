const test = require('brittle')
const ServerHandshake = require('../lib/server-handshake')

test('handshake recovery - passive wait expires without a puncher', function (t) {
  withClock((clock) => {
    const hs = handshake()
    hs.relayLost()
    t.is(clock.pending, 1)

    clock.advance(20)
    hs.relayLost()
    t.is(hs.relayFailedAt, 0, 'duplicate relay loss does not move the deadline')
    clock.advance(9)
    t.absent(hs.rawStream.destroyed)
    clock.advance(1)
    t.ok(hs.rawStream.destroyed)
    t.is(clock.pending, 0)
  })
})

test('handshake recovery - overlapping requests own cleanup past the deadline', function (t) {
  withClock((clock) => {
    const hs = handshake()
    hs.relayLost()
    clock.advance(10)
    hs.startRequest()
    hs.startRequest()
    t.is(clock.pending, 0, 'active work suspends the recovery timer')

    clock.advance(30)
    hs.endRequest()
    t.absent(hs.rawStream.destroyed, 'one request still owns cleanup')
    hs.endRequest()
    t.ok(hs.rawStream.destroyed, 'last request releases ownership after the deadline')
    t.is(clock.pending, 0)
  })
})

test('handshake recovery - resuming idle uses only the remaining grace', function (t) {
  withClock((clock) => {
    const hs = handshake()
    hs.startRequest()
    hs.relayLost()
    t.is(clock.pending, 0, 'no recovery timer starts during a request')
    clock.advance(10)
    hs.endRequest()
    t.is(clock.pending, 1)

    clock.advance(10)
    hs.startRequest()
    hs.endRequest()
    clock.advance(9)
    t.absent(hs.rawStream.destroyed)
    clock.advance(1)
    t.ok(hs.rawStream.destroyed, 'request cycles do not reset the deadline')
  })
})

test('handshake recovery - punching owns cleanup after the request returns', function (t) {
  withClock((clock) => {
    const hs = handshake()
    const p = puncher(hs)
    hs.startRequest()
    hs.relayLost()
    p.punching = true
    hs.endRequest()
    clock.advance(40)
    t.absent(hs.rawStream.destroyed)
    t.is(clock.pending, 0)

    p.destroy()
    t.ok(hs.aborted)
    t.ok(hs.rawStream.destroyed, 'puncher failure owns terminal cleanup')
  })
})

test('handshake recovery - initial waiting owns its own timeout', function (t) {
  withClock((clock) => {
    const hs = handshake()
    puncher(hs)
    hs.waitForPunch(10)
    hs.relayLost()
    t.is(clock.pending, 1, 'only the initial timeout is running')
    clock.advance(10)
    t.ok(hs.aborted)
    t.ok(hs.puncher.destroyed)
    t.ok(hs.rawStream.destroyed)
    t.is(clock.pending, 0)
  })
})

test('handshake recovery - abort keeps a healthy relay until it fails', function (t) {
  withClock((clock) => {
    const hs = handshake()
    hs.relayToken = Buffer.alloc(1)
    puncher(hs)
    hs.waitForPunch(10)
    hs.endPrepunch()
    hs.abort()
    t.ok(hs.puncher.destroyed)
    t.absent(hs.rawStream.destroyed)
    t.is(clock.pending, 0)

    hs.relayToken = null
    hs.relayLost()
    t.ok(hs.rawStream.destroyed, 'an already aborted direct path gets no new grace')
    t.is(clock.pending, 0)
  })
})

test('handshake recovery - direct success cancels pending cleanup', function (t) {
  withClock((clock) => {
    const hs = handshake()
    const rawStream = hs.rawStream
    hs.relayLost()
    hs.directConnected()
    hs.rawStream = null
    clock.advance(40)
    t.absent(rawStream.destroyed)
    t.is(hs.relayFailedAt, null)
    t.is(clock.pending, 0)

    hs.relayLost()
    t.is(clock.pending, 0, 'late relay closure cannot rearm completed recovery')
  })
})

test('handshake recovery - late request completion cannot rearm direct success', function (t) {
  withClock((clock) => {
    const hs = handshake()
    const rawStream = hs.rawStream
    hs.startRequest()
    hs.relayLost()
    clock.advance(40)
    hs.directConnected()
    hs.rawStream = null
    hs.endRequest()
    t.absent(rawStream.destroyed)
    t.is(hs.activeHolepunchRequests, 0)
    t.is(clock.pending, 0)
  })
})

test('handshake recovery - raw closure cancels recovery and releases the puncher', function (t) {
  withClock((clock) => {
    const hs = handshake()
    puncher(hs)
    hs.relayLost()
    hs.closed()
    t.ok(hs.puncher.destroyed)
    t.is(clock.pending, 0)
    t.is(hs.relayFailedAt, null)
  })
})

test('handshake recovery - server teardown cancels both kinds of waiting', function (t) {
  for (const initial of [false, true]) {
    withClock((clock) => {
      const hs = handshake()
      puncher(hs)
      if (initial) hs.waitForPunch(10)
      hs.relayLost()
      hs.destroy()
      t.ok(hs.rawStream.destroyed)
      t.ok(hs.puncher.destroyed)
      t.is(clock.pending, 0)
    })
  }
})

function handshake() {
  const hs = new ServerHandshake(30)
  hs.rawStream = {
    destroyed: false,
    on() {},
    destroy() {
      this.destroyed = true
    }
  }
  return hs
}

function puncher(hs) {
  hs.puncher = {
    destroyed: false,
    punching: false,
    onabort: () => hs.abort(),
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.punching = false
      this.onabort()
    }
  }
  return hs.puncher
}

// Run synchronously so no test-runner or network timers see the fake clock.
function withClock(run) {
  const dateNow = Date.now
  const schedule = global.setTimeout
  const cancel = global.clearTimeout
  const pending = new Set()
  let now = 0

  try {
    Date.now = () => now
    global.setTimeout = (fn, delay) => {
      const timer = { at: now + delay, fn, unref() {} }
      pending.add(timer)
      return timer
    }
    global.clearTimeout = (timer) => pending.delete(timer)

    run({
      get pending() {
        return pending.size
      },
      advance(ms) {
        const until = now + ms
        while (true) {
          const next = [...pending].sort((a, b) => a.at - b.at)[0]
          if (!next || next.at > until) break
          now = next.at
          pending.delete(next)
          next.fn()
        }
        now = until
      }
    })
  } finally {
    Date.now = dateNow
    global.setTimeout = schedule
    global.clearTimeout = cancel
  }
}
