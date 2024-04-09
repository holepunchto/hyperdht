const { spawn } = require('child_process')
const test = require('brittle')

const COUNT = 10000

test.skip(`Start a server ${COUNT} times`, { timeout: 0 }, async t => {
  t.plan(COUNT)

  for (let i = 0; i < COUNT; i++) {
    const startTime = Date.now()
    await t.test(async serverTest => {
      serverTest.plan(1)

      await new Promise((resolve, reject) => {
        const process = spawn('node', ['fixtures/start-server.js', i])
        process.stdout.on('data', data => serverTest.fail(data.toString()))
        process.stderr.on('data', data => serverTest.fail(data.toString()))
        process.on('exit', (code) => {
          if (code === 0) {
            serverTest.pass(`Took ${Date.now() - startTime} ms`)
            resolve()
          } else {
            serverTest.fail(`Test ${i} failed with code ${code}`)
            reject()
          }
        })
      })
    })
  }
})
