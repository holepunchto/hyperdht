const { spawn } = require('child_process')
const test = require('brittle')

const COUNT = 10000

test.skip(`Start a server ${COUNT} times`, { timeout: 0 }, async t => {
  t.plan(COUNT)

  for (let i = 0; i < COUNT; i++) {
    const startTime = Date.now()
    console.log(1)
    await t.test(async serverTest => {
      console.log(2)
      serverTest.plan(1)

      await new Promise((resolve, reject) => {
        console.log(3)
        const process = spawn('node', ['fixtures/start-server.js', i])
        process.stdout.on('data', data => {
          if (data.toString().includes('_update') || data.toString().includes('[server]')) {
            console.log(data.toString().trim())
            return
          }
          serverTest.fail(data.toString())
        })
        process.stderr.on('data', data => {
          if (data.toString().includes('repl-swarm')) {
            console.log(data.toString().trim())
            return
          }
          serverTest.fail(data.toString())
        })
        process.on('exit', (code) => {
          console.log('exit', code)
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
