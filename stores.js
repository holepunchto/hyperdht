'use strict'
const assert = require('assert')
const {
  crypto_generichash: hash,
  crypto_sign_keypair: createKeypair,
  crypto_sign_verify_detached: verify,
  crypto_sign_detached: sign,
  crypto_sign_PUBLICKEYBYTES: pkSize,
  crypto_sign_SECRETKEYBYTES: skSize,
  crypto_sign_BYTES: signSize,
  randombytes_buf: randomBytes
} = require('sodium-universal')
const { Transform, finished, pipeline } = require('readable-stream')
const { Mutable } = require('./messages')

const mutableEncoding = {
  encode (o) {
    if (o == null) return o
    return Mutable.encode(o)
  },
  decode (o) {
    if (o == null) return o
    return Mutable.decode(o)
  }
}

// PUT_VALUE_MAX_SIZE + packet overhead (i.e. the key etc.)
// should be less than the network MTU, normally 1400 bytes
const PUT_VALUE_MAX_SIZE = 1000

class ImmutableStore {
  constructor (dht, store) {
    this.dht = dht
    this.store = store
  }
  get (key, cb) {
    assert(Buffer.isBuffer(key), 'Key must be a buffer')
    const { store, dht } = this
    // if the querying node already has the immutable value
    // then there's no need to query the dht
    const streamMode = typeof cb !== 'function'
    const hexKey = key.toString('hex')
    const value = store.get(hexKey)
    if (value && streamMode === false) {
      return process.nextTick(cb, null, value)
    }

    let found = false
    const queryStream = dht.query('immutable-store', key)

    const responseStream = Transform({
      objectMode: true,
      transform (result, enc, next) {
        if (result.value === null) {
          next()
          return
        }
        const check = Buffer.alloc(32)
        hash(check, result.value)
        if (Buffer.compare(check, key) === 0) {
          if (streamMode) {
            next(null, result.value)
          } else {
            found = true
            cb(null, result.value)
            queryStream.destroy()
          }
        }
      }
    })
    if (value && streamMode) {
      // push local cached value to stream first
      responseStream.push(value)
    }
    pipeline(queryStream, responseStream, (err) => {
      if (err) {
        cb(err)
        return
      }
      if (streamMode === false && found === false) {
        cb(null, null)
      }
    })
    if (streamMode) return responseStream
  }
  put (value, cb) {
    assert(typeof cb === 'function', 'Callback is required')
    assert(Buffer.isBuffer(value), 'Value must be a buffer')
    assert(
      value.length <= PUT_VALUE_MAX_SIZE,
      `Value size must be <= ${PUT_VALUE_MAX_SIZE}`
    )
    const { store, dht } = this
    const key = Buffer.alloc(32)
    hash(key, value)
    // set locally for easy cached retrieval
    store.set(key.toString('hex'), value)

    // send to the dht
    const queryStream = dht.update('immutable-store', key, value)

    queryStream
      .once('warning', (err = {}) => {
        if (err.message === 'ERR_INVALID_INPUT') {
          queryStream.destroy(err)
        }
      })
      .once('data', () => {
        queryStream.destroy()
      })

    finished(queryStream, (err) => {
      if (err) {
        cb(err)
        return
      }
      cb(null, key)
    })
  }
  _command () {
    const { store } = this
    return {
      update ({ target, value }, cb) {
        const key = Buffer.alloc(32)
        hash(key, value)
        if (Buffer.compare(key, target) !== 0) {
          cb(Error('ERR_INVALID_INPUT'))
          return
        }
        store.set(key.toString('hex'), value)
        cb(null)
      },
      query ({ target }, cb) {
        cb(null, store.get(target.toString('hex')))
      }
    }
  }
}
class MutableStore {
  constructor (dht, store) {
    this.dht = dht
    this.store = store
  }
  salt (size = 32) {
    assert(
      size >= 16 && size <= 64,
      'salt size must be between 16 and 64 bytes (inclusive)'
    )
    const salt = Buffer.alloc(size)
    randomBytes(salt)
    return salt
  }
  keypair () {
    const publicKey = Buffer.alloc(pkSize)
    const secretKey = Buffer.alloc(skSize)
    createKeypair(publicKey, secretKey)
    return { publicKey, secretKey }
  }
  get (key, opts = {}, cb = opts) {
    const { dht } = this
    const { salt, seq = 0 } = opts
    assert(typeof seq === 'number', 'seq should be a number')
    if (salt) {
      assert(Buffer.isBuffer(salt), 'salt must be a buffer')
      assert(
        salt.length >= 16 && salt.length <= 64,
        'salt size must be between 16 and 64 bytes (inclusive)'
      )
    }
    const queryStream = dht.query('mutable-store', key, { salt, seq })
    let found = false
    const userSeq = seq
    const streamMode = typeof cb !== 'function'
    const responseStream = Transform({
      objectMode: true,
      transform (result, enc, next) {
        if (result.value === null) {
          next()
          return
        }
        const { value, sig, seq: storedSeq } = result.value
        const msg = salt ? Buffer.concat([Buffer.from([salt.length]), salt, value]) : value
        if (storedSeq >= userSeq && verify(sig, msg, key)) {
          if (streamMode) {
            next(null, { value, sig, seq: storedSeq, salt })
          } else {
            found = true
            cb(null, { value, sig, seq: storedSeq, salt })
            queryStream.destroy()
          }
        }
      }
    })
    finished(queryStream, () => { responseStream.push(null) })
    pipeline(queryStream, responseStream, (err) => {
      if (err) {
        cb(err)
        return
      }
      if (streamMode === false && found === false) {
        cb(null, null)
      }
    })
    if (streamMode) return responseStream
  }
  put (value, opts, cb) {
    assert(Buffer.isBuffer(value), 'Value must be a buffer')
    assert(typeof opts === 'object', 'Options are required')
    assert(typeof cb === 'function', 'Callback is required')
    assert(value.length <= PUT_VALUE_MAX_SIZE, `Value size must be <= ${PUT_VALUE_MAX_SIZE}`)
    const { dht } = this
    const { seq = 0, salt, keypair } = opts
    assert(keypair, 'keypair is required')
    const { secretKey, publicKey } = keypair
    assert(Buffer.isBuffer(secretKey), 'keypair.secretKey is required')
    assert(Buffer.isBuffer(publicKey), 'keypair.publicKey is required')
    assert(typeof seq === 'number', 'seq should be a number')
    if (salt) {
      assert(Buffer.isBuffer(salt), 'salt must be a buffer')
      assert(
        salt.length >= 16 && salt.length <= 64,
        'salt size must be between 16 and 64 bytes (inclusive)'
      )
    }
    const sig = Buffer.alloc(signSize)
    const msg = salt
      ? Buffer.concat([Buffer.from([salt.length]), salt, value])
      : value
    sign(sig, msg, secretKey)
    const key = publicKey
    const info = { value, sig, seq, salt }

    const queryStream = dht.update('mutable-store', key, info)

    queryStream
      .once('warning', (err = {}) => {
        if (err.message === 'ERR_INVALID_INPUT' || err.message === 'ERR_INVALID_SEQ') {
          queryStream.destroy(err)
        }
      })
      .once('data', () => {
        queryStream.destroy()
      })

    finished(queryStream, (err) => {
      if (err) {
        cb(err)
        return
      }
      cb(null, key, info)
    })
  }
  _command () {
    const { store } = this
    return {
      valueEncoding: mutableEncoding,
      update (input, cb) {
        if (input.value == null) {
          cb(null)
          return
        }
        const publicKey = input.target
        const { value, salt, sig, seq } = input.value
        const key = salt
          ? publicKey.toString('hex') + salt.toString('hex')
          : publicKey.toString('hex')
        const local = store.get(key)
        const msg = salt
          ? Buffer.concat([Buffer.from([salt.length]), salt, value])
          : value

        if (local && local.seq === seq && Buffer.compare(local.value, value) !== 0) {
          cb(Error('ERR_INVALID_SEQ'))
          return
        }
        const verified = verify(sig, msg, publicKey) &&
          (local ? seq >= local.seq : true)

        if (verified === false) {
          cb(Error('ERR_INVALID_INPUT'))
          return
        }
        store.set(key, { value, salt, sig, seq })
        cb(null)
      },
      query ({ target, value }, cb) {
        const { seq, salt } = value
        const key = salt
          ? target.toString('hex') + salt.toString('hex')
          : target.toString('hex')
        const result = store.get(key)
        if (result && result.seq >= seq) {
          cb(null, result)
        } else {
          cb(null, null)
        }
      }
    }
  }
}

module.exports = {
  ImmutableStore, MutableStore
}
