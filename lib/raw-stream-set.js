// TODO: check if we can/need to cleanly destroy raw streams
// not yet yielded as a connection

module.exports = class RawStreamSet {
  constructor (dht) {
    this._dht = dht

    this._prefix = 16 - 1 // 16 is the default stream-set side in udx
    this._streams = new Map()
  }

  add (opts) {
    console.log('creating raw stream with', opts)
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

  async clear ({ clean = true } = {}) {
    const entries = [...this._streams.values()]
    console.log('raw stream set clearing with clean', clean, 'nr entries', entries.length)
    const destroying = []

    const maxCleanEndDelayMs = 5000
    for (const stream of entries) {
      // console.log(stream)
      let prom = null
      if (clean) {
        const prom = new Promise((resolve, reject) => {
          const deadline = setTimeout(() => {
            console.log('deadline triggered')
            stream.destroy() // triggers stream 'close' cb
          }, maxCleanEndDelayMs)
          stream.once('close', () => {
            console.log('stream closed in raw-stream-set')
            resolve()
            clearTimeout(deadline)
          })
          console.log('ending stream')
          stream.end()
          console.log('ended stream')
          setImmediate(() => console.log('post immediate ended stream'))
        })
        destroying.push(prom)
      } else {
        prom = new Promise((resolve) => stream
          .once('close', resolve)
          .destroy()
        )
      }

      destroying.push(prom)
    }

    console.log('awaiting proms', destroying.length)
    await Promise.allSettled(destroying)
  }
}
