exports.clearRelayTimeout = clearRelayTimeout
exports.closeRelayConnection = closeRelayConnection
exports.destroyRelayConnection = destroyRelayConnection

function clearRelayTimeout(connectionOrHandshake) {
  clearTimeout(connectionOrHandshake.relayTimeout)
  connectionOrHandshake.relayTimeout = null
}

function closeRelayConnection(connectionOrHandshake) {
  const pairing = resetRelayConnection(connectionOrHandshake)

  if (pairing) pairing.closePairing()
}

function destroyRelayConnection(connectionOrHandshake) {
  const pairing = resetRelayConnection(connectionOrHandshake)

  if (pairing) pairing.release()
}

function resetRelayConnection(connectionOrHandshake) {
  if (connectionOrHandshake.relayTimeout) clearRelayTimeout(connectionOrHandshake)

  const pairing = connectionOrHandshake.relayPairing
  // Drop relay references so the app connection no longer keeps relay state alive.
  connectionOrHandshake.relayToken = null
  connectionOrHandshake.relaySocket = null
  connectionOrHandshake.relayClient = null
  connectionOrHandshake.relayPairing = null

  return pairing
}
