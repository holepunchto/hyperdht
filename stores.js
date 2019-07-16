'use strict'
const {
  crypto_generichash: hash,
  crypto_sign_keypair: createKeypair,
  crypto_sign_verify_detached: verify,
  crypto_sign_detached: sign,
  crypto_sign_PUBLICKEYBYTES: pkSize,
  crypto_sign_SECRETKEYBYTES: skSize,
  crypto_sign_BYTES: signSize
} = require('sodium-universal')
const { finished } = require('readable-stream')
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
    if (typeof cb !== 'function') throw Error('Callback is required')
    if (!Buffer.isBuffer(key)) throw Error('Key must be a buffer')
    const { store, dht } = this
    const hexKey = key.toString('hex')
    // if the querying node already has the immutable value
    // then there's no need to query the dht
    const value = store.get(hexKey)

    if (value) return process.nextTick(cb, null, value)

    const queryStream = dht.query('immutable-store', key)
    let found = false
    queryStream.on('data', (result) => {
      const check = Buffer.alloc(32)
      hash(check, result.value)
      if (Buffer.compare(check, key) === 0) {
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
        cb(null, null)
      }
    })
  }
  put (value, cb) {
    if (typeof cb !== 'function') throw Error('Callback is required')
    if (!Buffer.isBuffer(value)) throw Error('Value must be a buffer')
    if (value.length > PUT_VALUE_MAX_SIZE) { throw Error(`Value size must be <= ${PUT_VALUE_MAX_SIZE}`) }
    const { store, dht } = this
    const key = Buffer.alloc(32)
    hash(key, value)
    // set locally for easy cached retrieval
    store.set(key.toString('hex'), value)
    // send to the dht
    dht.update('immutable-store', key, value, (err) => {
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
class MutableStore  {
  constructor (dht, store) {
    this.dht = dht
    this.store = store
  }
  keypair () {
    const publicKey = Buffer.alloc(pkSize)
    const secretKey = Buffer.alloc(skSize)
    createKeypair(publicKey, secretKey)
    return { publicKey, secretKey }
  }
  get (key, opts, cb = opts) {
    if (typeof cb !== 'function') throw Error('Callback is required')
    if (typeof opts !== 'object') throw Error('Options are required')
    const { dht } = this
    const { salt, seq = 0 } = opts
    if (typeof seq !== 'number') throw Error('seq should be a number')
    if (salt && !Buffer.isBuffer(key)) throw Error('salt must be a buffer')
    const queryStream = dht.query('mutable-store', key, {salt, seq})
    let found = false 
    const userSeq = seq
    queryStream.on('data', (result) => {
      if (result.value === null) return
      const { value, sig, seq: storedSeq, salt } = result.value
      if (storedSeq >= userSeq && verify(sig, value, key)) {
        found = true
        cb(null, value, { sig, seq, salt })
        queryStream.destroy()
      }
    })

    finished(queryStream, (err) => {
      if (err) {
        cb(err)
        return
      }
      if (found === false) {
        cb(null, null)
      }
    })
  }
  put (value, opts, cb) {
    if (!Buffer.isBuffer(value)) throw Error('Value must be a buffer')
    if (value.length > PUT_VALUE_MAX_SIZE) { throw Error(`Value size must be <= ${PUT_VALUE_MAX_SIZE}`) }
    if (typeof opts !== 'object') throw Error('Options are required')
    if (typeof cb !== 'function') throw Error('Callback is required')
    if (value.length > PUT_VALUE_MAX_SIZE) { throw Error(`Value size must be <= ${PUT_VALUE_MAX_SIZE}`) }
    const { dht} = this
    const { seq = 0, salt, keypair } = opts
    if (!keypair) throw Error('keypair is required')
    const { secretKey, publicKey } = keypair
    if (!Buffer.isBuffer(secretKey)) throw Error('keypair.secretKey is required')
    if (!Buffer.isBuffer(publicKey)) throw Error('keypair.publicKey is required')
    if (typeof seq !== 'number') throw Error('seq should be a number')
    if (salt) {
      if (!Buffer.isBuffer(salt)) throw Error('salt must be a buffer')
      if (salt.length >= 16 && salt.length <= 64) { throw Error('salt length must be between 16 and 64 bytes (inclusive)') }
    }
    const sig = Buffer.alloc(signSize)
    sign(sig, value, secretKey)
    const key = publicKey
    const info = { value, sig, seq, salt }

    dht.update('mutable-store', key, info, (err) => {
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
        const { value, sig, seq } = input.value
        const key = publicKey.toString('hex')
        const local = store.get(key)
        const verified = verify(sig, value, publicKey) && 
          (local ? seq >= local.seq : true)
        
        if (verified === false) {
          cb(Error('ERR_INVALID_INPUT'))
          return
        }
        
        store.set(key, { key, value, sig, seq })  
        cb(null)
      },
      query ({target, value}, cb) {
        const key = target.toString('hex')
        const { seq } = value
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
