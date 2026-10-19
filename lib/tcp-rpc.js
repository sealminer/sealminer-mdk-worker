'use strict'

const net = require('node:net')
const {
  fail,
  ERR_API_TIMEOUT,
  ERR_API_CONNECTION,
  ERR_API_RESPONSE_INVALID,
  ERR_API_RESPONSE_TOO_LARGE,
  ERR_API_REQUEST_INVALID
} = require('./errors')

const DEFAULT_PORT = 4028
const DEFAULT_TIMEOUT_MS = 8000
// stats on a 1092-chip miner is large but bounded; anything past this is a
// malfunctioning or hostile peer, not a miner.
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/**
 * SealMiner 4028 transport.
 *
 * One request per connection, the CGMiner-lineage convention the firmware
 * follows: connect, write the payload, half-close so the peer knows the
 * request ended, then read until the peer closes. There is no framing header
 * and no documented keep-alive, so connection reuse is not attempted.
 */
class TcpRpc {
  constructor ({ host, port, timeoutMs, maxResponseBytes } = {}) {
    if (!host || typeof host !== 'string') fail(ERR_API_REQUEST_INVALID, 'host')
    this.host = host
    this.port = port || DEFAULT_PORT
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS
    this.maxResponseBytes = maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES
    this.sockets = new Set()
  }

  /**
   * @param {object} command e.g. { command: 'stats' } or
   *   { command: 'ascset', parameter: '0,workmode,{"mode":"normal"}' }
   * @returns {Promise<{ body: object, truncated: boolean, bytes: number }>}
   *   `truncated` mirrors the reply's `id` field: the firmware sets `id: 0`
   *   when it could not fit the whole answer. Detecting it is this layer's
   *   job; deciding what to do about it is not (see lib/api-client.js).
   */
  request (command) {
    if (!command || typeof command !== 'object' || !command.command) {
      fail(ERR_API_REQUEST_INVALID, 'command')
    }
    const payload = JSON.stringify(command)

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      this.sockets.add(socket)

      const chunks = []
      let bytes = 0
      let settled = false

      const finish = (err, value) => {
        if (settled) return
        settled = true
        this.sockets.delete(socket)
        socket.destroy()
        if (err) reject(err)
        else resolve(value)
      }

      const rejectWith = (code, detail) => {
        try {
          fail(code, detail)
        } catch (err) {
          finish(err)
        }
      }

      socket.setTimeout(this.timeoutMs)
      socket.once('connect', () => socket.end(payload))

      socket.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > this.maxResponseBytes) {
          rejectWith(ERR_API_RESPONSE_TOO_LARGE, `${bytes} bytes`)
          return
        }
        chunks.push(chunk)
      })

      socket.once('end', () => {
        if (settled) return
        const raw = Buffer.concat(chunks).toString('utf8')
        // Some firmware builds NUL-terminate the reply.
        const text = raw.replace(/\0+$/, '').trim()
        if (!text) {
          rejectWith(ERR_API_RESPONSE_INVALID, `${command.command}: empty reply`)
          return
        }
        let body
        try {
          body = JSON.parse(text)
        } catch (err) {
          rejectWith(ERR_API_RESPONSE_INVALID, `${command.command}: ${err.message}`)
          return
        }
        finish(null, { body, truncated: body.id === 0, bytes })
      })

      socket.once('timeout', () => rejectWith(ERR_API_TIMEOUT, command.command))
      socket.once('error', (err) => rejectWith(ERR_API_CONNECTION, `${command.command}: ${err.message}`))
    })
  }

  /** Destroy any in-flight sockets. Called by the host on shutdown. */
  stop () {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }
}

module.exports = { TcpRpc, DEFAULT_PORT, DEFAULT_TIMEOUT_MS }
