const b4a = require('b4a')
const safetyCatch = require('safety-catch')

exports.clearRelayTimeout = clearRelayTimeout
exports.closeRelayConnection = closeRelayConnection
exports.confirmDirectUpgrade = confirmDirectUpgrade
exports.destroyRelayConnection = destroyRelayConnection

function clearRelayTimeout(connectionOrHandshake) {
  clearTimeout(connectionOrHandshake.relayTimeout)
  connectionOrHandshake.relayTimeout = null
}

function closeRelayConnection(connectionOrHandshake) {
  const relay = resetRelayConnection(connectionOrHandshake)

  if (relay) closeRelay(relay)
}

function confirmDirectUpgrade(connectionOrHandshake, rawStream, remoteChanging) {
  const cleanup = () => {
    rawStream.off('data', ondirect)
    rawStream.off('message', ondirect)
    rawStream.off('close', cleanup)
  }

  function ondirect() {
    if (!connectionOrHandshake.validUpgrade) {
      // reset, aka assume from direct
      connectionOrHandshake.validUpgrade = true
      return
    }

    cleanup()
    closeRelayConnection(connectionOrHandshake)
  }

  const confirm = () => {
    rawStream.on('data', ondirect)
    rawStream.on('message', ondirect)
    rawStream.once('close', cleanup)

    // Use a raw UDX message to make the peer observe the direct path without
    // writing application data into the secret stream.
    if (rawStream.trySend) rawStream.trySend(b4a.alloc(0))
  }

  if (!remoteChanging) {
    confirm()
    return
  }

  remoteChanging.then(confirm).catch(safetyCatch)
}

function destroyRelayConnection(connectionOrHandshake) {
  const relay = resetRelayConnection(connectionOrHandshake)

  if (relay) destroyRelay(relay)
}

function resetRelayConnection(connectionOrHandshake) {
  if (connectionOrHandshake.relayTimeout) clearRelayTimeout(connectionOrHandshake)

  const relay = connectionOrHandshake.relayPairing || connectionOrHandshake.relaySocket
  // Drop relay references so the app connection no longer keeps relay state alive.
  connectionOrHandshake.relayToken = null
  connectionOrHandshake.relaySocket = null
  connectionOrHandshake.relayClient = null
  connectionOrHandshake.relayPairing = null

  return relay
}

function closeRelay(relay) {
  if (relay.closePairing) return relay.closePairing()
  if (relay.release) return relay.release()
  relay.end()
}

function destroyRelay(relay) {
  if (relay.release) return relay.release()
  relay.destroy()
}
