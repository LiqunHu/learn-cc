---
name: mcp-builder
description: Build MCP (Model Context Protocol) servers that give Claude/Cursor new capabilities. Use when user wants to create an MCP server, add tools, or integrate external services.
---

# MCP Server Building Skill

You now have expertise in building MCP (Model Context Protocol) servers. MCP enables AI agents to interact with external services through a standardized protocol.

## What is MCP?

MCP servers expose:
- **Tools**: Functions the model can call (like API endpoints)
- **Resources**: Data the model can read (like files or database records)
- **Prompts**: Pre-built prompt templates

## Quick Start: Node.js MCP Server

### 1. Project Setup

```bash
mkdir my-mcp-server && cd my-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk zod
```

Set `"type": "module"` in `package.json`.

### 2. Basic Server Template

```javascript
// index.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'my-server',
  version: '1.0.0',
})

server.tool(
  'hello',
  'Say hello to someone',
  { name: z.string().describe('The name to greet') },
  async ({ name }) => ({
    content: [{ type: 'text', text: `Hello, ${name}!` }],
  }),
)

server.tool(
  'add_numbers',
  'Add two numbers together',
  {
    a: z.number().describe('First number'),
    b: z.number().describe('Second number'),
  },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
```

### 3. Register with Cursor / Claude

Add to MCP config (e.g. Cursor MCP settings or `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/index.mjs"]
    }
  }
}
```

## Advanced Patterns

### External API Integration

```javascript
server.tool(
  'get_weather',
  'Get current weather for a city',
  { city: z.string().describe('City name') },
  async ({ city }) => {
    const resp = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHER_API_KEY}&q=${encodeURIComponent(city)}`,
    )
    const data = await resp.json()
    return {
      content: [{
        type: 'text',
        text: `${city}: ${data.current.temp_c}C, ${data.current.condition.text}`,
      }],
    }
  },
)
```

### Database Access

```javascript
import Database from 'better-sqlite3'

const db = new Database('data.db')

server.tool(
  'query_db',
  'Execute a read-only SQL query',
  { sql: z.string().describe('SELECT query only') },
  async ({ sql }) => {
    if (!sql.trim().toUpperCase().startsWith('SELECT')) {
      return { content: [{ type: 'text', text: 'Error: Only SELECT queries allowed' }] }
    }
    const rows = db.prepare(sql).all()
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
  },
)
```

### Resources (Read-only Data)

```javascript
import fs from 'node:fs/promises'

server.resource(
  'settings',
  'config://settings',
  async (uri) => ({
    contents: [{
      uri: uri.href,
      text: await fs.readFile('settings.json', 'utf-8'),
    }],
  }),
)
```

## Testing

```bash
# Test with MCP Inspector
npx @modelcontextprotocol/inspector node index.mjs

# Or send a JSON-RPC message on stdin
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node index.mjs
```

## Best Practices

1. **Clear tool descriptions**: The model uses these to decide when to call tools
2. **Input validation**: Use Zod schemas; always sanitize inputs
3. **Error handling**: Return meaningful error messages in `content`
4. **Async by default**: Use async/await for I/O operations
5. **Security**: Never expose sensitive operations without auth
6. **Idempotency**: Tools should be safe to retry
