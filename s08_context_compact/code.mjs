// s08_context_compact - Context Compact

// Four-layer compaction pipeline inserted before LLM calls:

//     L1: snip_compact      — trim middle messages when count > 50
//     L2: micro_compact     — replace old tool_results with placeholders
//     L3: tool_result_budget — persist large results to disk
//     L4: compact_history   — LLM full summary (1 API call)

//     Emergency: reactive_compact — when API still returns prompt_too_long

//     ┌─────────────────────────────────────────────────────────────┐
//     │  messages[]                                                 │
//     │    ↓                                                        │
//     │  L3 budget ─→ L1 snip ─→ L2 micro ─→ [token > threshold?]  │
//     │                                      ├─ No  → LLM          │
//     │                                      └─ Yes → L4 summary   │
//     │                                              ↓              │
//     │                                          LLM call           │
//     │                                    [prompt_too_long?]        │
//     │                                      └─ Yes → reactive      │
//     └─────────────────────────────────────────────────────────────┘

// Core principle: cheap first, expensive last.
// Execution order matches CC source: budget → snip → micro → auto.

import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import fs from 'node:fs/promises'
import { exec } from 'node:child_process'
import { glob } from 'glob'
import { request } from 'gaxios'
import path from 'path'
import YAML from 'yaml'

const rl = readline.createInterface({ input, output })

const url = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
const apiKey = process.env.OPENAI_API_KEY || ''
const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo'

const PWD = process.cwd()

const SKILLS_DIR = PWD + '/skills'
const TRANSCRIPT_DIR = PWD + '/.transcripts'
const TOOL_RESULTS_DIR = PWD + '/.task_outputs/tool-results'

let CURRENT_TODOS = []

// s07: Skill catalog scan (used by build_system below)
// Parse YAML frontmatter from SKILL.md. Returns (meta, body)
function _parse_frontmatter(text) {
  if (!text.startsWith('---')) {
    return { meta: {}, body: text }
  }

  const parts = text.split('---', 3)

  if (parts.length < 3) {
    return { meta: {}, body: text }
  }

  let meta = {}
  try {
    meta = YAML.parse(parts[1]) || {}
  } catch (error) {
    console.log('yaml parse error')
  }

  return { meta, body: parts[2].trim() }
}

// Build skill registry at startup (used for safe lookup in load_skill)
const SKILL_REGISTRY = {}

// Scan skills/ dir, populate SKILL_REGISTRY with name/description/content.
async function _scan_skills() {
  try {
    for await (const file of fs.glob('**/**/*.md', { cwd: SKILLS_DIR })) {
      console.log(file)
      const raw = await fs.readFile(`${SKILLS_DIR}/${file}`, 'utf8')
      const { meta, body } = _parse_frontmatter(raw)
      const name = meta['name'] || path.dirname(file)
      const desc = meta['description'] || body.split('\n')[0].replace('#', '').trim()
      SKILL_REGISTRY[name] = { name: name, description: desc, content: raw }
    }
  } catch (error) {
    console.log('skills dir not exist')
  }
}

await _scan_skills()

// List all skills (name + one-line description).
function list_skills() {
  if (!SKILL_REGISTRY) {
    return '(no skills found)'
  }

  return Object.keys(SKILL_REGISTRY)
    .map((s) => `- **${SKILL_REGISTRY[s]['name']}**: ${SKILL_REGISTRY[s]['description']}`)
    .join('\n')
}

// s07: SYSTEM includes skill catalog (cheap — just names + descriptions)
// Build SYSTEM prompt with skill catalog injected at startup.
function build_system() {
  const catalog = list_skills()
  return `You are a coding agent at ${PWD}.
  Skills available:\n${catalog}\n
  Use load_skill to get full details when needed.
  `
}

const SYSTEM = build_system()

// s07: subagent gets its own system prompt — no skill loading, no task
const SUB_SYSTEM = `You are a coding agent at ${PWD}.
Complete the task you were given, then return a concise summary.
Do not delegate further.
`

// FROM s02-s04 (unchanged): Tool Implementations
async function run_bash({ command }) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(`Error executing command: ${error.message}`)
      } else if (stderr) {
        resolve(`stderr: ${stderr}`)
      } else {
        resolve(stdout)
      }
    })
  })
}

function safePath(filePath) {
  const resolvedPath = path.resolve(PWD, filePath)
  if (!resolvedPath.startsWith(PWD)) {
    throw new Error(`Error: Path escapes workspace"${filePath}".`)
  }
  return resolvedPath
}

async function run_read_file({ path, limit = 1024 }) {
  try {
    const safe_path = safePath(path)
    const data = await fs.readFile(safe_path, { encoding: 'utf-8' })
    return data.split('\n').slice(0, limit).join('\n')
  } catch (error) {
    throw new Error(`Error: ${error.message}`)
  }
}

async function run_write_file({ path, content }) {
  try {
    const safe_path = safePath(path)
    await fs.writeFile(safe_path, content, { encoding: 'utf-8' })
    return `Wrote to ${safe_path}`
  } catch (error) {
    throw new Error(`Error: ${error.message}`)
  }
}

async function run_edit_file({ path, old_text, new_text }) {
  try {
    const safe_path = safePath(path)
    let data = await fs.readFile(safe_path, { encoding: 'utf-8' })
    if (!data.includes(old_text)) {
      throw new Error(`Text "${old_text}" not found in file.`)
    }
    data = data.replace(old_text, new_text)
    await fs.writeFile(safe_path, data, { encoding: 'utf-8' })
    return `Edited ${safe_path}`
  } catch (error) {
    throw new Error(`Error: ${error.message}`)
  }
}

async function run_glob({ pattern, cwd, ignore, dot, nodir, absolute, maxDepth, nocase, follow }) {
  try {
    const extraIgnore = ignore == null ? [] : Array.isArray(ignore) ? ignore : [ignore]
    const files = await glob(pattern, {
      cwd: cwd ? safePath(cwd) : PWD,
      ignore: ['node_modules/**', ...extraIgnore],
      ...(dot !== undefined && { dot }),
      ...(nodir !== undefined && { nodir }),
      ...(absolute !== undefined && { absolute }),
      ...(maxDepth !== undefined && { maxDepth }),
      ...(nocase !== undefined && { nocase }),
      ...(follow !== undefined && { follow }),
    })
    return files.map((file) => file.filename || file).join('\n') || '(no matches)'
  } catch (error) {
    throw new Error(`Error: ${error.message}`)
  }
}

// NEW in s05: todo_write tool — plan only, no execution
function _normalize_todos(todos) {
  if (typeof todos === 'string') {
    todos = JSON.parse(todos)
  }
  if (!Array.isArray(todos)) {
    throw new Error(`Todos must be an array or JSON string, got: ${JSON.stringify(todos)}`)
  }
  return todos.map((todo) => {
    if (todo && todo.content && todo.status) {
      if (todo.status !== 'pending' && todo.status !== 'in_progress' && todo.status !== 'completed') {
        throw new Error(`Invalid todo status: ${todo.status}`)
      }
      return todo
    } else {
      throw new Error(`Invalid todo format: ${JSON.stringify(todo)}`)
    }
  })
}

function run_todo_write({ todos }) {
  try {
    const normalized_todos = _normalize_todos(todos)
    CURRENT_TODOS = normalized_todos
    const lines = ['\n\x1b[33m## Current Tasks\x1b[0m']
    for (const [i, t] of CURRENT_TODOS.entries()) {
      const icon = { pending: ' ', in_progress: '\x1b[36m▸\x1b[0m', completed: '\x1b[32m✓\x1b[0m' }[t.status] || ' '
      lines.push(`  [${icon}] ${t.content}`)
    }
    console.log(lines.join('\n'))
    return `Updated ${CURRENT_TODOS.length} todos`
  } catch (error) {
    return error.message
  }
}

// NEW in s07: load_skill — runtime full content loading
// Load full skill content. Lookup via registry — no path traversal.
function load_skill({ name }) {
  const skill = SKILL_REGISTRY[name]
  if (!skill) {
    return `Skill not found: ${name}`
  }
  return skill['content']
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: {
        command: {
          type: 'string',
          description: 'The shell command to execute, e.g. "ls -la" or "cat file.txt"',
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file contents.',
      parameters: {
        path: {
          type: 'string',
          description: 'The path to the file to read.',
        },
        limit: {
          type: 'integer',
          description: 'The maximum number of bytes to read from the file.',
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file.',
      parameters: {
        path: {
          type: 'string',
          description: 'The path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file.',
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace exact text in a file once.',
      parameters: {
        path: {
          type: 'string',
          description: 'The path to the file to edit.',
        },
        old_text: {
          type: 'string',
          description: 'The exact text to replace in the file.',
        },
        new_text: {
          type: 'string',
          description: 'The new text to replace the old text with.',
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match, e.g. "**/*.js" or "src/**/*.{ts,tsx}".',
        },
        cwd: {
          type: 'string',
          description: 'Directory to search in. Defaults to the workspace root.',
        },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns to exclude from matches, e.g. ["dist/**", "*.min.js"]. node_modules/** is always ignored.',
        },
        dot: {
          type: 'boolean',
          description: 'Include dotfiles (e.g. .gitignore) in matches. Default false.',
        },
        nodir: {
          type: 'boolean',
          description: 'Match only files, not directories. Default false.',
        },
        absolute: {
          type: 'boolean',
          description: 'Return absolute paths instead of paths relative to cwd. Default false.',
        },
        maxDepth: {
          type: 'integer',
          description: 'Maximum directory depth to traverse below cwd.',
        },
        nocase: {
          type: 'boolean',
          description: 'Case-insensitive matching. Default false (true on Windows).',
        },
        follow: {
          type: 'boolean',
          description: 'Follow symlinked directories when expanding **. Default false.',
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Create and manage a task list for your current coding session.',
      parameters: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Description of the task.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Status of the task.' },
            },
            required: ['content', 'status'],
          },
          description: 'Array of todo objects to update the current task list.',
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: 'Load the full content of a skill by name.',
      parameters: {
        name: {
          type: 'string',
          description: 'skill name.',
        },
        required: ['name'],
      },
    },
  },
  // s08 change: new compact tool — triggers compact_history, not a no-op
  {
    type: 'function',
    function: {
      name: 'compact',
      description: 'Summarize earlier conversation to free context space.',
      parameters: {
        focus: {
          type: 'string',
          description: 'Optional focus for the summary, e.g. "current goal" or "files changed".',
        },
        required: ['focus'],
      },
    },
  },
]

const TOOL_HANDLERS = {
  bash: run_bash,
  read_file: run_read_file,
  write_file: run_write_file,
  edit_file: run_edit_file,
  glob: run_glob,
  todo_write: run_todo_write,
  load_skill: load_skill,
}

const SUB_TOOLS = TOOLS.filter((tool) => tool.function.name !== 'todo_write')

const SUB_TOOL_HANDLERS = { ...TOOL_HANDLERS }
delete SUB_TOOL_HANDLERS['todo_write']

function extract_text(message) {
  // Extract text from message content blocks.
  if (!message || !Array.isArray(message) || message.length === 0) {
    return ''
  }
  const lastMessage = message[message.length - 1]
  return lastMessage.content || ''
}

async function spawn_subagent({ description }) {
  // Spawn a subagent with fresh messages[], return summary only.
  console.log(`\n\x1b[35m[Subagent spawned]\x1b[0m`)
  const messages = [{ role: 'user', content: description }]
  //safety limit
  for (let i = 0; i < 30; i++) {
    try {
      const response = await request({
        url: `${url}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        data: {
          model: model,
          messages: [{ role: 'system', content: SUB_SYSTEM }, ...messages],
          enable_thinking: false,
          tools: SUB_TOOLS,
        },
      })

      const assistant_output = response.data.choices[0].message
      messages.push(assistant_output)
      // If the model didn't call a tool, we're done
      if (!assistant_output.tool_calls) {
        break
      }

      for (const tool_call of assistant_output.tool_calls) {
        const func_name = tool_call.function.name
        const func_args = JSON.parse(tool_call.function.arguments || '{}')
        console.log(`\x1b[33m${func_name}(${JSON.stringify(func_args)})\x1b[0m`)

        // s04 change: hook replaces hard-coded check_permission()
        const blocked = await trigger_hooks('PreToolUse', { func_name, func_args })
        if (blocked) {
          messages.push({ role: 'tool', content: `Error: ${blocked}`, tool_call_id: tool_call.id })
          continue
        }

        const handler = SUB_TOOL_HANDLERS[func_name]
        if (!handler) {
          messages.push({ role: 'tool', content: `Error: No handler for tool "${func_name}"`, tool_call_id: tool_call.id })
          continue
        }
        try {
          const tool_result = await handler(func_args)

          await trigger_hooks('PostToolUse', { func_name, func_args, tool_result })

          messages.push({ role: 'tool', content: tool_result, tool_call_id: tool_call.id })
        } catch (err) {
          messages.push({ role: 'tool', content: String(err), tool_call_id: tool_call.id })
        }
      }
    } catch (error) {
      console.log(error)
    }
  }

  // Issue 5: fallback if safety limit hit during tool_use
  const result = extract_text(messages)

  if (!result) {
    return 'Subagent stopped after 30 turns without final answer.'
  }

  console.log('\x1b[35m[Subagent done]\x1b[0m')

  // only summary, entire message history discarded
  return result
}

TOOLS.push({
  type: 'function',
  function: {
    name: 'task',
    description: 'Launch a subagent to handle a complex subtask. Returns only the final conclusion.',
    parameters: {
      description: {
        type: 'string',
        description: 'The description of the subtask to be handled by the subagent.',
      },
      required: ['description'],
    },
  },
})

TOOL_HANDLERS['task'] = spawn_subagent

// NEW in s08: Four-Layer Compaction Pipeline
const CONTEXT_LIMIT = 50000
const KEEP_RECENT = 3
const PERSIST_THRESHOLD = 30000

function estimate_size(msgs) {
  if (typeof msgs === 'object') {
    return JSON.stringify(msgs).length
  }
  return msgs.length
}

function _block_type(block) {
  return block['type'] || ''
}

// L1: snipCompact — trim middle messages
function snip_compact(messages, max_messages = 50) {
  if (messages.length <= max_messages) return messages
  const keep_head = 3
  const keep_tail = max_messages - 3
  let head_end = keep_head
  let tail_start = messages.length - keep_tail

  if (messages[head_end - 1].tool_calls) {
    while (head_end < messages.length && messages[head_end].tool_calls) {
      head_end += 1
    }
  }

  if (tail_start > 0 && tail_start < messages.length && messages[tail_start]['role'] == 'tool' && messages[tail_start - 1].tool_calls) {
    tail_start -= 1
  }

  if (head_end >= tail_start) {
    return messages
  }
  const snipped = tail_start - head_end

  return [...messages.slice(0, head_end), { role: 'user', content: `[snipped ${snipped} messages]` }, ...messages.slice(tail_start)]
}

// L2: microCompact — old result placeholders
function micro_compact(messages) {
  let tool_count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role == 'tool') {
      if (tool_count > KEEP_RECENT) {
        messages[i].content = '[Earlier tool result compacted. Re-run if needed.]'
      } else {
        tool_count += 1
      }
    }
  }
  return messages
}

// L3: toolResultBudget — persist large results to disk
function persist_large_output(tool_call_id, content) {
  if (content.length <= PERSIST_THRESHOLD) {
    return content
  }
  fs.mkdir(TOOL_RESULTS_DIR, { recursive: true })
  const filename = `${TOOL_RESULTS_DIR}/${tool_call_id}.txt`
  fs.writeFile(filename, content)
  return `<persisted-output>\nFull output: ${filename}\nPreview:\n${content.substring(0, 2000)}\n</persisted-output>`
}

function tool_result_budget(messages, max_bytes = 200_000) {
  const last = messages[messages.length - 1]
  if (!last || last['role'] != 'user') return messages

  const total = messages.reduce((acc, msg) => acc + msg['content'].length, 0)
  if (total <= max_bytes) {
    return messages
  }

  messages.map((msg) => {
    if (msg['role'] == 'tool' && msg['tool_call_id']) {
      msg['content'] = persist_large_output(msg['tool_call_id'], msg['content'])
    }
  })
  return messages
}

// L4: autoCompact — LLM full summary
function write_transcript(messages) {
  fs.mkdir(TRANSCRIPT_DIR, { recursive: true })

  const path = `${TRANSCRIPT_DIR}/transcript-${Date.now()}.json`
  fs.writeFile(path, JSON.stringify(messages))
  return path
}

async function summarize_history(messages) {
  const conversation = JSON.stringify(messages).slice(0, 80000)
  const prompt = `Summarize this coding-agent conversation so work can continue.
Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed,
4. remaining work, 5. user constraints.
Be compact but concrete.


${conversation}`

  const response = await request({
    url: `${url}`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    data: {
      model: model,
      messages: [{ role: 'user', content: prompt }],
      enable_thinking: false,
      max_tokens: 2000
    },
  })

  const assistant_output = response.data.choices[0].message
  return assistant_output.content || '(empty summary)'
}

async function compact_history(messages) {
  const transcript_path = write_transcript(messages)
  console.log(`[transcript saved: ${transcript_path}]`)
  const summary = await summarize_history(messages)
  return [{ role: 'assistant', content: `[Compacted]\n\n${summary}` }]
}

// Emergency: reactiveCompact — on API error
async function reactive_compact(messages) {
  const transcript = write_transcript(messages)
  let tail_start = messages.length - 5 > 0 ? messages.length - 5 : 0
  if (tail_start > 0 && tail_start < messages.length && messages[tail_start]['role'] == 'tool' && messages[tail_start - 1].tool_calls) {
    tail_start -= 1
  }
  const summary = await summarize_history(messages.slice(0, tail_start))
  return [
    { role: 'assistant', content: `[Reactive compact]\n\n${summary}\n\n[transcript saved: ${transcript}]` },
    ...messages.slice(tail_start, messages.length),
  ]
}

// NEW in s04: Hook System (s03 permission logic now via hooks)

const HOOKS = { UserPromptSubmit: [], PreToolUse: [], PostToolUse: [], Stop: [] }

function register_hook(event, callback) {
  if (!HOOKS[event]) {
    throw new Error(`Unknown hook event: ${event}`)
  }
  HOOKS[event].push(callback)
}

async function trigger_hooks(event, context) {
  if (!HOOKS[event]) {
    throw new Error(`Unknown hook event: ${event}`)
  }
  for (const callback of HOOKS[event]) {
    const result = await callback(context)
    if (result) return result
  }
}

const DENY_LIST = ['rm -rf /', 'sudo', 'shutdown', 'reboot', 'mkfs', 'dd if=', '> /dev/sda']
const DESTRUCTIVE = ['rm ', '> /etc/', 'chmod 777']
async function permission_hook({ func_name, func_args }) {
  // PreToolUse: s03 check_permission() logic moved here.
  if (func_name === 'bash') {
    for (const denyCommand of DENY_LIST) {
      if (func_args.command.includes(denyCommand)) {
        return `Blocked: ${denyCommand} is on the deny list`
      }
    }

    for (const destructiveCommand of DESTRUCTIVE) {
      if (func_args.command.includes(destructiveCommand)) {
        console.log(`\n\x1b[33m⚠  Potentially destructive command\x1b[0m`)
        console.log(`   Tool: ${func_name}(${JSON.stringify(func_args)})`)
        const choice = (await rl.question(' Allow? [y/N]')).trim().toLowerCase()
        if (!(choice === 'y' || choice === 'yes')) {
          return `Permission denied by user`
        }
      }
    }
  }

  if (func_name === 'write_file' || func_name === 'edit_file') {
    const safePath = path.resolve(PWD, func_args.path)
    if (!safePath.startsWith(PWD)) {
      console.log(`\n\x1b[33m⚠  File path escapes workspace\x1b[0m`)
      console.log(`   Tool: ${func_name}(${JSON.stringify(func_args)})`)
      const choice = (await rl.question(' Allow? [y/N]')).trim().toLowerCase()
      if (!(choice === 'y' || choice === 'yes')) {
        return `Permission denied by user`
      }
    }
  }
}

function log_hook({ func_name, func_args }) {
  const args_preview = JSON.stringify(func_args || '').slice(0, 100)
  console.log(`\n\x1b[34mℹ  Tool call: ${func_name}(${args_preview})\x1b[0m`)
}

function large_output_hook({ func_name, func_args, tool_result }) {
  if (tool_result.length > 1000) {
    console.log(`\n\x1b[33m⚠  Large output from ${func_name} (${tool_result.length} bytes)\x1b[0m`)
  }
}

// UserPromptSubmit hook: log user input before it reaches the LLM
function context_inject_hook(message) {
  console.log(`\n\x1b[32m💬 [HOOK] UserPromptSubmit: working in ${PWD}\x1b[0m`)
}

function summary_hook(message) {
  let tool_count = 0
  for (const msg of message) {
    tool_count += msg.tool_calls ? msg.tool_calls.length : 0
  }
  console.log(`\n\x1b[32m✅ [HOOK] Stop: session used ${tool_count} tool calls\x1b[0m`)
}

register_hook('UserPromptSubmit', context_inject_hook)
register_hook('PreToolUse', permission_hook)
register_hook('PreToolUse', log_hook)
register_hook('PostToolUse', large_output_hook)
register_hook('Stop', summary_hook)

// retry limit for reactive compact
const MAX_REACTIVE_RETRIES = 1

async function agent_loop(message) {
  let reactive_retries = 0
  while (true) {
    // s08 change: three preprocessors (0 API calls, cheap first)
    // Order matches CC source: budget → snip → micro
    message = tool_result_budget(message)
    message = snip_compact(message)
    message = micro_compact(message)

    // s08 change: tokens still over threshold → LLM summary (1 API call)
    if (estimate_size(message) > CONTEXT_LIMIT) {
      console.log('[auto compact]')
      message = await compact_history(message)
    }
    try {
      const response = await request({
        url: `${url}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        data: {
          model: model,
          messages: [{ role: 'system', content: SYSTEM }, ...message],
          enable_thinking: false,
          tools: TOOLS,
        },
      })

      const assistant_output = response.data.choices[0].message
      message.push(assistant_output)
      // If the model didn't call a tool, we're done
      if (!assistant_output.tool_calls) {
        let force = await trigger_hooks('Stop', message)
        if (force) {
          message.push({ role: 'user', content: force })
          continue
        }
        return
      }

      for (const tool_call of assistant_output.tool_calls) {
        const func_name = tool_call.function.name
        const func_args = JSON.parse(tool_call.function.arguments || '{}')
        console.log(`\x1b[33m${func_name}(${JSON.stringify(func_args)})\x1b[0m`)

        // s08: compact tool triggers compact_history, not a no-op string
        if(func_name === 'compact') {
          message = compact_history(message)
          message.push({ role: 'tool', content: '[Compacted. Conversation history has been summarized.]', tool_call_id: tool_call.id })
          break
        }

        // s04 change: hook replaces hard-coded check_permission()
        const blocked = await trigger_hooks('PreToolUse', { func_name, func_args })
        if (blocked) {
          message.push({ role: 'tool', content: `Error: ${blocked}`, tool_call_id: tool_call.id })
          continue
        }
        // const permission_granted = await check_permission(func_name, func_args)
        // if (!permission_granted) {
        //   message.push({ role: 'tool', content: `Error: Permission denied for tool "${func_name}"`, tool_call_id: tool_call.id })
        //   continue
        // }

        const handler = TOOL_HANDLERS[func_name]
        if (!handler) {
          message.push({ role: 'tool', content: `Error: No handler for tool "${func_name}"`, tool_call_id: tool_call.id })
          continue
        }
        try {
          const tool_result = await handler(func_args)

          await trigger_hooks('PostToolUse', { func_name, func_args, tool_result })

          message.push({ role: 'tool', content: tool_result, tool_call_id: tool_call.id })
        } catch (err) {
          message.push({ role: 'tool', content: String(err), tool_call_id: tool_call.id })
        }
      }
    } catch (error) {
      if(error.message.toLowerCase().includes('prompt_too_long') && reactive_retries < MAX_REACTIVE_RETRIES) {
        console.log('[reactive compact]')
        message = await reactive_compact(message)
        reactive_retries += 1
        continue
      } else {
        console.error('Error fetching data:', error)
        return
      }
    }
  }
}

async function main() {
  try {
    console.log('s08: Context Compact — four-layer compaction pipeline')
    console.log('输入问题，回车发送。输入 q 退出。\n')

    const history = []
    while (true) {
      let query
      try {
        query = await rl.question('\x1b[36ms01 >> \x1b[0m')
      } catch {
        break
      }
      if (['q', 'quit', 'exit', ''].includes(query.trim().toLowerCase())) {
        break
      }
      await trigger_hooks('UserPromptSubmit', query)

      history.push({ role: 'user', content: query })
      await agent_loop(history)
      // Print the model's final text response
      const response_content = history[history.length - 1]?.content
      if (response_content) {
        console.log(response_content)
      }
      console.log()
    }
    rl.close()
  } catch (error) {
    console.error('Error fetching data:', error)
  }
}

main()
