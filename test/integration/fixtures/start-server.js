const DHT = require('../../../')

/*
  This test is put into a fixture to make sure that each run is its own.
  It will exit with 0 if able to start server, and 1 if there was an error when starting.
  It will hang if, for some reason, `await server.listen()` never returns [TBC: this is the bug I am hunting]
*/

log(`[server] i am alive. pid=${process.pid}`)

async function run () {
  const node = new DHT()
  const server = node.createServer(() => { })
  const aliveInterval = setInterval(() => log('[server] i am still alive'), 500)
  aliveInterval.unref()
  log('[server] ready to listen')
  await server.listen()
  // await server.close() // Add this to the test when the current bug has been found
  log('[server] after await server.listen()')
}

run()
  .then(() => {
    log('[server] should do exit 0')
    process.exit(0)
  })
  .catch(err => {
    log('[server] should do exit 1')
    log(`[server] error: ${err.message}`)
    process.exit(1)
  })

function log (str) {
  console.log(str)
}
