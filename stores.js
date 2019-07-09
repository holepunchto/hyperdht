'use strict'
const {
  crypto_generichash: hash,
  crypto_sign_keypair: sign
} = require('sodium-universal')
const { finished } = require('readable-stream')

const PUT_VALUE_MAX_SIZE = 1000

const immutable = (store) => ({
  get (key, cb) {
    if (typeof cb !== 'function') throw Error('Callback is required')
    if (!Buffer.isBuffer(key)) throw Error('Key must be a buffer')
    const hexKey = key.toString('hex')
    // if the querying node already has the immutable value
    // then there's no need to query the dht
    const value = store.get(hexKey)

    if (value) return process.nextTick(cb, null, value)

    const queryStream = this.query('immutable-store', key)
    let found = false
    queryStream.on('data', (result) => {
      const verify = Buffer.alloc(32)
      hash(verify, result.value)
      if (Buffer.compare(verify, key) === 0) {
        found = true
        cb(null, result.value)
        queryStream.destroy()
      } // silently ignore bad values
    })

    finished(queryStream, (err) => {
      if (err) {
        cb(err)
        return
      }
      if (found === false) {
        cb(Error('Not Found'))
      }
    })
  },
  put (value, cb) {
    if (typeof cb !== 'function') throw Error('Callback is required')
    if (!Buffer.isBuffer(value)) throw Error('Value must be a buffer')
    if (value.length > PUT_VALUE_MAX_SIZE) { throw Error(`Value size must be <= ${PUT_VALUE_MAX_SIZE}`) }
    const key = Buffer.alloc(32)
    hash(key, value)
    // set locally for easy cached retrieval
    store.set(key.toString('hex'), value)
    // send to the dht
    this.update('immutable-store', key, value, (err) => {
      if (err) {
        cb(err)
        return
      }
      cb(null, key)
    })
  },
  command: {
    update ({ value }, cb) {
      if (value == null) {
        cb(null)
        return
      }
      const key = Buffer.alloc(32)
      hash(key, value)
      store.set(key.toString('hex'), value)
      cb(null)
    },
    query ({ target }, cb) {
      cb(null, store.get(target.toString('hex')))
    }
  }
})

const mutable = (store) => ({
  get (key, opts, cb) {
    throw Error('Not Currently Supported')
    if (typeof opts !== 'object') throw Error('Options are required')
    if (typeof cb !== 'function') throw Error('Callback is required')
  },
  put (value, opts, cb) {
    throw Error('Not Currently Supported')
    if (typeof opts !== 'object') throw Error('Options are required')
    if (typeof cb !== 'function') throw Error('Callback is required')
  },
  command: {
    update ({ value }, cb) {
    },
    query ({ target }, cb) {
    }
  }
})

module.exports = {
  mutable, immutable
}
