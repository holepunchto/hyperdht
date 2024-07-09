const EventEmitter = require('events')

class RelayState extends EventEmitter {
  constructor (relayThrough = null, remotePublicKey = null) {
    super()
    this.relayThrough = relayThrough
    this.remotePublicKey = remotePublicKey
    this.state = RelayState.NOT_STARTED
  }

  get relaying () {
    return this.state === RelayState.RELAYING
  }

  close () {
    this.state = RelayState.CLOSED
  }

  pairing () {
    this.state = RelayState.PAIRING
    this.emit('pairing')
  }

  paired () {
    this.state = RelayState.RELAYING
    this.emit('relay')
  }

  unrelay () {
    this.state = RelayState.NOT_RELAYING
    this.emit('unrelay')
  }
}

RelayState.NOT_STARTED = 1
RelayState.PAIRING = 2
RelayState.RELAYING = 3
RelayState.NOT_RELAYING = 4
RelayState.CLOSED = 5

module.exports = RelayState
