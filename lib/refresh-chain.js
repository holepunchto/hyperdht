const sodium = require('sodium-universal')
const b4a = require('b4a')

module.exports = function createRefreshChain (cnt) {
  const blocks = new Array(cnt)
  if (!blocks.length) return blocks

  const all = b4a.allocUnsafe(cnt * 32 + 32)

  let prev = all.subarray(all.byteLength - 32)
  sodium.randombytes_buf(prev)

  for (let i = cnt - 1; i >= 0; i--) {
    blocks[i] = all.subarray(32 * i, 32 * i + 32)
    sodium.crypto_generichash(blocks[i], prev)
    prev = blocks[i]
  }

  return blocks
}
