#!/usr/bin/env node
/**
 * Agent Scaffold Script - Create a new agent project with best practices.
 *
 * Usage:
 *   node init_agent.mjs <agent-name> [--level 0-4] [--path <output-dir>]
 *
 * Examples:
 *   node init_agent.mjs my-agent                 # Level 1 (4 tools)
 *   node init_agent.mjs my-agent --level 0      # Minimal (bash only)
 *   node init_agent.mjs my-agent --level 2      # With TodoWrite
 *   node init_agent.mjs my-agent --path ./bots  # Custom output directory
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const TEMPLATES = {
  0: `#!/usr/bin/env node
/**
 * Level 0 Agent - Bash is All You Need (~60 lines)
 *
 * Core insight: One tool (bash) can do everything.
 * Subagents via self-recursion: node {{name}}.mjs "subtask"
 */

import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { exec } from 'node:child_process'
import { request } from 'gaxios'

const rl = readline.createInterface({ input, output })
const url = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
const apiKey = process.env.OPENAI_API_KEY || ''
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'

const SYSTEM = \`You are a coding agent. Use bash for everything:
- Read: cat, grep, find, ls
- Write: echo 'content' > file
- Subagent: node {{name}}.mjs "subtask"
\`

const TOOLS = [{
  type: 'function',
  function: {
    name: 'bash',
    description: 'Execute shell command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
}]

async function run(prompt, history = []) {
  history.push({ role: 'user', content: prompt })
  while (true) {
    const r = await request({
      url, method: 'POST',
      headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
      data: { model, messages: [{ role: 'system', content: SYSTEM }, ...history], tools: TOOLS },
    })
    const msg = r.data.choices[0].message
    history.push(msg)
    if (!msg.tool_calls?.length) return msg.content || ''
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments || '{}')
      console.log(\`> \${args.command}\`)
      const output = await new Promise((resolve) => {
        exec(args.command, { timeout: 60_000 }, (err, stdout, stderr) => {
          if (err) resolve(\`Error: \${err.message}\`)
          else resolve((stdout + stderr).trim().slice(0, 50_000) || '(empty)')
        })
      })
      history.push({ role: 'tool', content: output, tool_call_id: tc.id })
    }
  }
}

async function main() {
  const history = []
  console.log('{{name}} - Level 0 Agent\\nType \\'q\\' to quit.\\n')
  while (true) {
    let q
    try { q = (await rl.question('>> ')).trim() } catch { break }
    if (['q', 'quit', ''].includes(q.toLowerCase())) break
    console.log(await run(q, history), '\\n')
  }
  rl.close()
}

main()
`,

  1: `#!/usr/bin/env node
/**
 * Level 1 Agent - Model as Agent (~200 lines)
 *
 * Core insight: 4 tools cover 90% of coding tasks.
 * The model IS the agent. Code just runs the loop.
 */

import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { exec } from 'node:child_process'
import { request } from 'gaxios'

const rl = readline.createInterface({ input, output })
const url = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
const apiKey = process.env.OPENAI_API_KEY || ''
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const WORKDIR = process.cwd()

const SYSTEM = \`You are a coding agent at \${WORKDIR}.

Rules:
- Prefer tools over prose. Act, don't just explain.
- Never invent file paths. Use ls/find first if unsure.
- Make minimal changes. Don't over-engineer.
- After finishing, summarize what changed.\`

const TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'Run shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read file contents',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write content to file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace exact text in file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } } },
]

function safePath(p) {
  const resolved = path.resolve(WORKDIR, p)
  if (!resolved.startsWith(WORKDIR)) throw new Error(\`Path escapes workspace: \${p}\`)
  return resolved
}

async function execute(name, args) {
  if (name === 'bash') {
    const dangerous = ['rm -rf /', 'sudo', 'shutdown', '> /dev/']
    if (dangerous.some((d) => args.command.includes(d))) return 'Error: Dangerous command blocked'
    return new Promise((resolve) => {
      exec(args.command, { cwd: WORKDIR, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) resolve(\`Error: \${err.message}\`)
        else resolve((stdout + stderr).trim().slice(0, 50_000) || '(empty)')
      })
    })
  }
  if (name === 'read_file') {
    try { return (await fs.readFile(safePath(args.path), 'utf-8')).slice(0, 50_000) }
    catch (e) { return \`Error: \${e.message}\` }
  }
  if (name === 'write_file') {
    try {
      const p = safePath(args.path)
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, args.content, 'utf-8')
      return \`Wrote \${args.content.length} bytes to \${args.path}\`
    } catch (e) { return \`Error: \${e.message}\` }
  }
  if (name === 'edit_file') {
    try {
      const p = safePath(args.path)
      let content = await fs.readFile(p, 'utf-8')
      if (!content.includes(args.old_text)) return \`Error: Text not found in \${args.path}\`
      content = content.replace(args.old_text, args.new_text)
      await fs.writeFile(p, content, 'utf-8')
      return \`Edited \${args.path}\`
    } catch (e) { return \`Error: \${e.message}\` }
  }
  return \`Unknown tool: \${name}\`
}

async function agent(prompt, history = []) {
  history.push({ role: 'user', content: prompt })
  while (true) {
    const response = await request({
      url, method: 'POST',
      headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
      data: { model, messages: [{ role: 'system', content: SYSTEM }, ...history], tools: TOOLS },
    })
    const assistant = response.data.choices[0].message
    history.push(assistant)
    if (!assistant.tool_calls?.length) return assistant.content || ''
    for (const tc of assistant.tool_calls) {
      const args = JSON.parse(tc.function.arguments || '{}')
      console.log(\`> \${tc.function.name}:\`, JSON.stringify(args).slice(0, 100))
      const output = await execute(tc.function.name, args)
      console.log(\`  \${String(output).slice(0, 100)}...\`)
      history.push({ role: 'tool', content: output, tool_call_id: tc.id })
    }
  }
}

async function main() {
  console.log(\`{{name}} - Level 1 Agent at \${WORKDIR}\`)
  console.log("Type 'q' to quit.\\n")
  const history = []
  while (true) {
    let query
    try { query = (await rl.question('>> ')).trim() } catch { break }
    if (['q', 'quit', 'exit', ''].includes(query.toLowerCase())) break
    console.log(await agent(query, history), '\\n')
  }
  rl.close()
}

main()
`,
}

const ENV_TEMPLATE = `# API Configuration
OPENAI_API_KEY=sk-xxx
OPENAI_API_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
`

const PACKAGE_TEMPLATE = (name) => `{
  "name": "${name}",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node ${name}.mjs"
  },
  "dependencies": {
    "dotenv": "^16.4.0",
    "gaxios": "^6.0.0"
  }
}
`

function createAgent(name, level, outputDir) {
  if (!(level in TEMPLATES)) {
    console.error(`Error: Level ${level} not yet implemented in scaffold.`)
    console.error('Available levels: 0 (minimal), 1 (4 tools)')
    console.error('For levels 2-4, copy from the learn-cc s05–s07 lessons.')
    process.exit(1)
  }

  const agentDir = path.join(outputDir, name)
  fs.mkdirSync(agentDir, { recursive: true })

  const agentFile = path.join(agentDir, `${name}.mjs`)
  const template = TEMPLATES[level] ?? TEMPLATES[1]
  fs.writeFileSync(agentFile, template.replaceAll('{{name}}', name))
  console.log(`Created: ${agentFile}`)

  const envFile = path.join(agentDir, '.env.example')
  fs.writeFileSync(envFile, ENV_TEMPLATE)
  console.log(`Created: ${envFile}`)

  const pkgFile = path.join(agentDir, 'package.json')
  fs.writeFileSync(pkgFile, PACKAGE_TEMPLATE(name))
  console.log(`Created: ${pkgFile}`)

  const gitignore = path.join(agentDir, '.gitignore')
  fs.writeFileSync(gitignore, '.env\nnode_modules/\n')
  console.log(`Created: ${gitignore}`)

  console.log(`\nAgent '${name}' created at ${agentDir}`)
  console.log(`\nNext steps:`)
  console.log(`  1. cd ${agentDir}`)
  console.log(`  2. cp .env.example .env`)
  console.log(`  3. Edit .env with your API key`)
  console.log(`  4. npm install`)
  console.log(`  5. node ${name}.mjs`)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    level: { type: 'string', default: '1' },
    path: { type: 'string', default: process.cwd() },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help || !positionals[0]) {
  console.log(`Usage: node init_agent.mjs <agent-name> [--level 0-4] [--path <output-dir>]

Levels:
  0  Minimal (~60 lines) - Single bash tool, self-recursion for subagents
  1  Basic (~200 lines)  - 4 core tools: bash, read, write, edit
  2  Todo (~300 lines)   - + TodoWrite for structured planning
  3  Subagent (~450)     - + Task tool for context isolation
  4  Skills (~550)       - + Skill tool for domain expertise
`)
  process.exit(values.help ? 0 : 1)
}

const name = positionals[0]
const level = Number.parseInt(values.level, 10)
if (![0, 1, 2, 3, 4].includes(level)) {
  console.error('Error: --level must be 0-4')
  process.exit(1)
}

createAgent(name, level, path.resolve(values.path))
