exports.clearRelayTimeout = clearRelayTimeout
exports.closeRelayConnection = closeRelayConnection
exports.destroyRelayConnection = destroyRelayConnection

function clearRelayTimeout(connectionOrHandshake) {
  clearTimeout(connectionOrHandshake.relayTimeout)
  connectionOrHandshake.relayTimeout = null
}

function closeRelayConnection(connectionOrHandshake) {
  const relay = resetRelayConnection(connectionOrHandshake)

  if (relay) closeRelay(relay)
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
