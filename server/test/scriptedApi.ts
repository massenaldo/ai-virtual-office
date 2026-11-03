import http from 'node:http'

// A local stand-in for the Anthropic Messages API, for running the real SDK binary without a key or a model. Each request that
// carries tools is one model turn and is answered with the next scripted turn: some text and/or tool calls. Everything else
// gets a short text answer. Every request body is kept so a test can see what the SDK sent, including tool results.

export type ScriptedBlock = { text: string } | { tool: string; input: Record<string, unknown> }
export type ScriptedTurn = ScriptedBlock[]
export type RecordedRequest = { url: string; tools: string[]; messages: Array<{ role: string; content: unknown }> }

type Event = [string, Record<string, unknown>]
const message = (id: string): Event => ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'scripted', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }]

function turnEvents(id: string, turn: ScriptedTurn): Event[] {
  const events: Event[] = [message(id)]
  turn.forEach((block, index) => {
    if ('text' in block) {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }])
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `${id}-t${index}`, name: block.tool, input: {} } }])
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }])
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
  })
  const calls = turn.some((b) => 'tool' in b)
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: calls ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return events
}

export async function startScriptedApi(script: ScriptedTurn[]) {
  const requests: RecordedRequest[] = []
  let turn = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let json: { stream?: boolean; tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> } | null = null
      try { json = JSON.parse(body) } catch { json = null }
      const isTurn = req.method === 'POST' && req.url?.startsWith('/v1/messages') && json?.stream === true && (json.tools?.length ?? 0) > 0
      if (isTurn && json) requests.push({ url: req.url ?? '', tools: (json.tools ?? []).map((t) => t.name), messages: json.messages ?? [] })
      const events = isTurn ? turnEvents(`scripted-${turn}`, script[Math.min(turn++, script.length - 1)]) : req.method === 'POST' && req.url?.startsWith('/v1/messages') ? turnEvents('scripted-aux', [{ text: 'ok' }]) : null
      if (events === null) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }) }
}
