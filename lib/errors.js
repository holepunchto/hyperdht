module.exports = class DHTError extends Error {
  constructor (msg, code, fn = DHTError) {
    super(`${code}: ${msg}`)
    this.code = code

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, fn)
    }
  }

  get name () {
    return 'DHTError'
  }

  static BAD_HANDSHAKE_REPLY (msg = 'Bad handshake reply') {
    return new DHTError(msg, 'BAD_HANDSHAKE_REPLY', DHTError.BAD_HANDSHAKE_REPLY)
  }

  static BAD_HOLEPUNCH_REPLY (msg = 'Bad holepunch reply') {
    return new DHTError(msg, 'BAD_HOLEPUNCH_REPLY', DHTError.BAD_HOLEPUNCH_REPLY)
  }

  static HOLEPUNCH_ABORTED (msg = 'Holepunch aborted') {
    return new DHTError(msg, 'HOLEPUNCH_ABORTED', DHTError.HOLEPUNCH_ABORTED)
  }

  static HOLEPUNCH_INVALID (msg = 'Invalid holepunch payload') {
    return new DHTError(msg, 'HOLEPUNCH_INVALID', DHTError.HOLEPUNCH_INVALID)
  }

  static HOLEPUNCH_PROBE_TIMEOUT (msg = 'Holepunching probe did not finish in time') {
    return new DHTError(msg, 'HOLEPUNCH_PROBE_TIMEOUT', DHTError.HOLEPUNCH_PROBE_TIMEOUT)
  }

  static HOLEPUNCH_DOUBLE_RANDOMIZED_NATS (msg = 'Both remote and local NATs are randomized') {
    return new DHTError(msg, 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS', DHTError.HOLEPUNCH_DOUBLE_RANDOMIZED_NATS)
  }

  static CANNOT_HOLEPUNCH (msg = 'Cannot holepunch to remote') {
    return new DHTError(msg, 'CANNOT_HOLEPUNCH', DHTError.CANNOT_HOLEPUNCH)
  }

  static REMOTE_NOT_HOLEPUNCHING (msg = 'Remote is not holepunching') {
    return new DHTError(msg, 'REMOTE_NOT_HOLEPUNCHING', DHTError.REMOTE_NOT_HOLEPUNCHING)
  }

  static REMOTE_NOT_HOLEPUNCHABLE (msg = 'Remote is not holepunchable') {
    return new DHTError(msg, 'REMOTE_NOT_HOLEPUNCHABLE', DHTError.REMOTE_NOT_HOLEPUNCHABLE)
  }

  static REMOTE_ABORTED (msg = 'Remote aborted') {
    return new DHTError(msg, 'REMOTE_ABORTED', DHTError.REMOTE_ABORTED)
  }

  static HANDSHAKE_UNFINISHED (msg = 'Handshake did not finish') {
    return new DHTError(msg, 'HANDSHAKE_UNFINISHED', DHTError.HANDSHAKE_UNFINISHED)
  }

  static HANDSHAKE_INVALID (msg = 'Received invalid handshake') {
    return new DHTError(msg, 'HANDSHAKE_INVALID', DHTError.HANDSHAKE_INVALID)
  }

  static ALREADY_LISTENING (msg = 'Already listening') {
    return new DHTError(msg, 'ALREADY_LISTENING', DHTError.ALREADY_LISTENING)
  }

  static NODE_DESTROYED (msg = 'Node destroyed') {
    return new DHTError(msg, 'NODE_DESTROYED', DHTError.NODE_DESTROYED)
  }

  static PEER_CONNECTION_FAILED (msg = 'Could not connect to peer') {
    return new DHTError(msg, 'PEER_CONNECTION_FAILED', DHTError.PEER_CONNECTION_FAILED)
  }

  static PEER_NOT_FOUND (msg = 'Peer not found') {
    return new DHTError(msg, 'PEER_NOT_FOUND', DHTError.PEER_NOT_FOUND)
  }

  static STREAM_NOT_CONNECTED (msg = 'Stream is not connected') {
    return new DHTError(msg, 'STREAM_NOT_CONNECTED', DHTError.STREAM_DISCONNECTED)
  }

  static SERVER_INCOMPATIBLE (msg = 'Server is using an incompatible version') {
    return new DHTError(msg, 'SERVER_INCOMPATIBLE', DHTError.SERVER_INCOMPATIBLE)
  }

  static SERVER_ERROR (msg = 'Server returned an error') {
    return new DHTError(msg, 'SERVER_ERROR', DHTError.SERVER_ERROR)
  }
}
