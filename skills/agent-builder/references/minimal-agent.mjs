#!/usr/bin/env node
/**
 * Minimal Agent Template - Copy and customize this.
 *
 * Simplest working agent (~100 lines): 3 tools + loop.
 *
 * Usage:
 *   1. Set OPENAI_API_KEY (and optionally OPENAI_API_BASE_URL, OPENAI_MODEL)
 *   2. node minimal-agent.mjs
 *   3. Type commands, 'q' to quit
 */

import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import fs from 'node:fs/promises'
import { exec } from 'node:child_process'
import path from 'node:path'
import { request } from 'gaxios'

const rl = readline.createInterface({ input, output })

const url = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
const apiKey = process.env.OPENAI_API_KEY || ''
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const WORKDIR = process.cwd()

const SYSTEM = `You are a coding agent at ${WORKDIR}.

Rules:
- Use tools to complete tasks
- Prefer action over explanation
- Summarize what you did when done`

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file contents',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
]

async function executeTool(name, args) {
  if (name === 'bash') {
    return new Promise((resolve) => {
      exec(args.command, { cwd: WORKDIR, timeout: 60_000 }, (error, stdout, stderr) => {
        if (error) resolve(`Error: ${error.message}`)
        else resolve((stdout + stderr).trim() || '(empty)')
      })
    })
  }

  if (name === 'read_file') {
    try {
      const data = await fs.readFile(path.resolve(WORKDIR, args.path), 'utf-8')
      return data.slice(0, 50_000)
    } catch (e) {
      return `Error: ${e.message}`
    }
  }

  if (name === 'write_file') {
    try {
      const p = path.resolve(WORKDIR, args.path)
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, args.content, 'utf-8')
      return `Wrote ${args.content.length} bytes to ${args.path}`
    } catch (e) {
      return `Error: ${e.message}`
    }
  }

  return `Unknown tool: ${name}`
}

async function agent(prompt, history = []) {
  history.push({ role: 'user', content: prompt })

  while (true) {
    const response = await request({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      data: {
        model,
        messages: [{ role: 'system', content: SYSTEM }, ...history],
        tools: TOOLS,
      },
    })

    const assistant = response.data.choices[0].message
    history.push(assistant)

    if (!assistant.tool_calls?.length) {
      return assistant.content || ''
    }

    for (const tc of assistant.tool_calls) {
      const name = tc.function.name
      const args = JSON.parse(tc.function.arguments || '{}')
      console.log(`> ${name}:`, args)
      const output = await executeTool(name, args)
      console.log(`  ${String(output).slice(0, 100)}...`)
      history.push({ role: 'tool', content: output, tool_call_id: tc.id })
    }
  }
}

async function main() {
  console.log(`Minimal Agent - ${WORKDIR}`)
  console.log("Type 'q' to quit.\n")

  const history = []
  while (true) {
    let query
    try {
      query = (await rl.question('>> ')).trim()
    } catch {
      break
    }
    if (['q', 'quit', 'exit', ''].includes(query.toLowerCase())) break
    console.log(await agent(query, history))
    console.log()
  }
  rl.close()
}

main()
