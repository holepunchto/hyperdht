const DHT = require('../../../')
const repl = require('repl-swarm')
const fs = require('fs')

/*
  This test is put into a fixture to make sure that each run is its own.
  It will exit with 0 if able to start server, and 1 if there was an error when starting.
  It will hang if, for some reason, `await server.listen()` never returns [TBC: this is the bug I am hunting]
*/

log(`[server] i am alive. pid=${process.pid}`)

async function run () {
  const node = new DHT()
  const server = node.createServer(() => { })
  repl({ data: { node, server } })
  const aliveInterval = setInterval(() => log('[server] i am still alive'), 500)
  aliveInterval.unref()
  log('[server] ready to listen')
  await server.listen()
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
    error(err)
    process.exit(1)
  })

function log (str) {
  // Not doing appendFileSync at the moment, to not change the timing too much
  fs.appendFile('./log.log', `[${new Date().toISOString()}] [${process.pid}] ${str}\n`, () => { })
  console.log(str)
}
