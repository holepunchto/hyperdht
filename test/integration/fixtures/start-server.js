const DHT = require('../../../')

/*
  This test is put into a fixture to make sure that each run is its own.
  It will exit with 0 if able to start server, and 1 if there was an error when starting.
  It will hang if, for some reason, `await server.listen()` never returns [TBC: this is the bug I am hunting]
*/

async function run () {
  const node = new DHT()
  const server = node.createServer(() => { })
  await server.listen()
}

run()
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
