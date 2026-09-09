import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeMessage, decodeMessages, createRpcClient } from '../rpc.js'
import { PassThrough } from 'node:stream'

describe('encodeMessage', () => {
  it('encodes a JSON-RPC request with Content-Length header', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, method: 'initialize', params: {} }
    const encoded = encodeMessage(msg)
    const body = JSON.stringify(msg)
    assert.ok(encoded.startsWith(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`))
    assert.ok(encoded.endsWith(body))
  })

  it('encodes a JSON-RPC response', () => {
    const msg = { jsonrpc: '2.0' as const, id: 2, result: { capabilities: {} } }
    const encoded = encodeMessage(msg)
    const body = JSON.stringify(msg)
    assert.ok(encoded.startsWith(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`))
    assert.ok(encoded.endsWith(body))
  })
})

describe('decodeMessages', () => {
  it('decodes a single complete message from buffer', () => {
    const msg = { jsonrpc: '2.0' as const, id: 1, result: { capabilities: {} } }
    const raw = encodeMessage(msg)
    const { messages, rest } = decodeMessages(raw)
    assert.equal(messages.length, 1)
    assert.deepEqual(messages[0], msg)
    assert.equal(rest, '')
  })

  it('returns empty when body is incomplete', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    const { messages, rest } = decodeMessages(header + body.slice(0, 5))
    assert.equal(messages.length, 0)
    assert.ok(rest.length > 0)
    assert.ok(rest.length < header.length + body.length)
  })

  it('decodes multiple messages in one buffer', () => {
    const msg1 = { jsonrpc: '2.0' as const, id: 1, result: { a: 1 } }
    const msg2 = { jsonrpc: '2.0' as const, id: 2, result: { b: 2 } }
    const raw = encodeMessage(msg1) + encodeMessage(msg2)
    const { messages } = decodeMessages(raw)
    assert.equal(messages.length, 2)
  })

  it('handles empty input', () => {
    const { messages, rest } = decodeMessages('')
    assert.equal(messages.length, 0)
    assert.equal(rest, '')
  })

  it('returns rest for trailing incomplete message', () => {
    const msg1 = { jsonrpc: '2.0' as const, id: 1, result: { a: 1 } }
    // Content-Length claims 999 bytes but only 5 chars of body follow
    const raw = encodeMessage(msg1) + 'Content-Length: 999\r\n\r\n{"jso'
    const { messages, rest } = decodeMessages(raw)
    assert.equal(messages.length, 1)
    assert.equal(rest, 'Content-Length: 999\r\n\r\n{"jso')
  })
})

describe('createRpcClient', () => {
  /**
   * Create a pair of connected PassThrough streams.
   * Client writes to toServer → server reads from fromClient (same stream, readable side).
   * Server writes to toClient → client reads from fromServer (same stream, readable side).
   */
  function connect() {
    const toServer = new PassThrough()
    const toClient = new PassThrough()
    // fromClient = toServer (readable side of what client writes)
    // fromServer = toClient (readable side of what server writes)
    return { toServer, toClient, fromClient: toServer, fromServer: toClient }
  }

  it('sends request and resolves response by id', async () => {
    const { toServer, toClient, fromClient } = connect()

    // Client: reads from toClient (server responses), writes to toServer
    const client = createRpcClient(toClient, toServer)

    // Server: reads from fromClient, writes responses to toClient
    let serverBuf = ''
    fromClient.on('data', (chunk: Buffer) => {
      serverBuf += chunk.toString()
      const { messages, rest } = decodeMessages(serverBuf)
      serverBuf = rest
      for (const msg of messages) {
        if ('method' in msg && msg.method === 'test' && 'id' in msg) {
          toClient.write(encodeMessage({
            jsonrpc: '2.0' as const,
            id: msg.id,
            result: { ok: true },
          }))
        }
      }
    })

    const result = await client.request('test', { foo: 'bar' })
    assert.deepEqual(result, { ok: true })
    client.dispose()
  })

  it('rejects on error response', async () => {
    const { toServer, toClient, fromClient } = connect()
    const client = createRpcClient(toClient, toServer)

    let serverBuf = ''
    fromClient.on('data', (chunk: Buffer) => {
      serverBuf += chunk.toString()
      const { messages, rest } = decodeMessages(serverBuf)
      serverBuf = rest
      for (const msg of messages) {
        if ('method' in msg && msg.method === 'bad' && 'id' in msg) {
          toClient.write(encodeMessage({
            jsonrpc: '2.0' as const,
            id: msg.id,
            error: { code: -32600, message: 'Invalid Request' },
          }))
        }
      }
    })

    await assert.rejects(
      () => client.request('bad', {}),
      /Invalid Request/,
    )
    client.dispose()
  })

  it('handles notifications via onNotification', async () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)

    const received: unknown[] = []
    client.onNotification('window/logMessage', (params) => {
      received.push(params)
    })

    // Push notification from server side directly to client's readable stream
    toClient.push(encodeMessage({
      jsonrpc: '2.0' as const,
      method: 'window/logMessage',
      params: { message: 'hello' },
    }))

    await new Promise(r => setTimeout(r, 20))
    assert.equal(received.length, 1)
    assert.deepEqual(received[0], { message: 'hello' })
    client.dispose()
  })

  it('times out a request that never receives a response', async () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer, { requestTimeoutMs: 25 })

    await assert.rejects(
      () => client.request('initialize', {}),
      /LSP request initialize timed out after 0.025s/,
    )
    client.dispose()
  })

  it('abortAllPending rejects every in-flight request', async () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)

    const pending = client.request('initialize', {})
    client.abortAllPending(new Error('LSP process died'))

    await assert.rejects(() => pending, /LSP process died/)
    client.dispose()
  })

  it('dispose rejects pending requests instead of leaving them hanging', async () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)

    const pending = client.request('initialize', {})
    client.dispose()

    await assert.rejects(() => pending, /RPC client disposed/)
  })

  it('dispose does not throw', () => {
    const { toServer, toClient } = connect()
    const client = createRpcClient(toClient, toServer)
    client.dispose()
  })
})
