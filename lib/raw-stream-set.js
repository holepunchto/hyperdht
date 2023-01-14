module.exports = class RawStreamSet {
  constructor (dht) {
    this._dht = dht

    this._prefix = 16 - 1 // 16 is the default stream-set side in udx
    this._streams = new Map()
  }

  add (opts) {
    const self = this

    // TODO: we should prob have a udx helper for id generation, given the slight complexity
    // of the below. requires a PRNG in udx tho.

    let id = 0

    while (true) {
      id = (Math.random() * 0x100000000) >>> 0

      if (this._streams.has(id & this._prefix)) continue
      break
    }

    // always have ~50% change of rolling a free one
    if (2 * this._streams.size >= this._prefix) {
      // ie 0b11111 = 0b1111 + 1 + 0b1111
      this._prefix = 2 * this._prefix + 1

      // move the prefixes over
      const next = new Map()
      for (const stream of this._streams.values()) {
        next.set(stream.id & this._prefix, stream)
      }
      this._streams = next
    }

    const stream = this._dht.udx.createStream(id, opts)
    this._streams.set(id & this._prefix, stream)

    stream.on('close', onclose)

    return stream

    function onclose () {
      self._streams.delete(id & self._prefix)
    }
  }

  async destroy () {
    const destroying = []

    for (const stream of this._streams.values()) {
      destroying.push(new Promise((resolve) => stream
        .once('close', resolve)
        .destroy()
      ))
    }

    await Promise.allSettled(destroying)
  }
}
