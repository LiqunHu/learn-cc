// s04: Hooks — move extension logic out of the loop, onto hooks.

//   User types query
//        │
//        ▼
//   ┌──────────────────┐
//   │ UserPromptSubmit │ ── trigger_hooks() before LLM
//   └────────┬─────────┘
//            ▼
//   ┌────────────┐     ┌─────────────────────────────┐
//   │  messages  │────▶│  LLM (stop_reason=tool_use?)│
//   └────────────┘     │   No ──▶ Stop hooks ──▶ exit │
//                      │   Yes ──▶ tool_use block ──┐ │
//                      └────────────────────────────┘ │
//                                                     ▼
//                                           ┌──────────────────┐
//                                           │ trigger_hooks()   │
//                                           │  PreToolUse:      │
//                                           │   permission_hook │
//                                           │   log_hook        │
//                                           └───────┬──────────┘
//                                                   │ (not blocked)
//                                           ┌───────▼──────────┐
//                                           │ TOOL_HANDLERS[x]  │
//                                           └───────┬──────────┘
//                                                   │
//                                           ┌───────▼──────────┐
//                                           │ trigger_hooks()   │
//                                           │  PostToolUse:     │
//                                           │   large_output    │
//                                           └───────┬──────────┘
//                                                   │
//                                           results ──▶ back to messages

// Changes from s03:
//   + HOOKS registry (event -> list of callbacks)
//   + register_hook() / trigger_hooks()
//   + context_inject_hook (UserPromptSubmit)
//   + permission_hook, log_hook (PreToolUse)
//   + large_output_hook (PostToolUse)
//   + summary_hook (Stop)
//   - check_permission() removed from loop body
//     (logic moved into permission_hook, triggered via PreToolUse)

import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import fs from 'node:fs/promises'
import { exec } from 'node:child_process'
import { glob } from 'glob'
import { request } from 'gaxios'
import path from 'path'
const rl = readline.createInterface({ input, output })

const url = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
const apiKey = process.env.OPENAI_API_KEY || ''
const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo'

const PWD = process.cwd()

const SYSTEM = `You are a coding agent at ${PWD}. Use tools to solve tasks. Act, don't explain.`

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
async function permission_hook({func_name, func_args}) {
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

    const reason = check_deny_list(func_args.command)
    if (reason) {
      console.log(`\n\x1b[31m⛔  ${reason}\x1b[0m`)
      return false
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

function log_hook(func_name, func_args) {
  const args_preview = JSON.stringify(func_args).slice(0, 100)
  console.log(`\n\x1b[34mℹ  Tool call: ${func_name}(${args_preview})\x1b[0m`)
}

function large_output_hook({func_name, func_args, tool_result}) {
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
]

const TOOL_HANDLERS = {
  bash: run_bash,
  read_file: run_read_file,
  write_file: run_write_file,
  edit_file: run_edit_file,
  glob: run_glob,
}

async function agent_loop(message) {
  while (true) {
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

    const results = []
    for (const tool_call of assistant_output.tool_calls) {
      const func_name = tool_call.function.name
      const func_args = JSON.parse(tool_call.function.arguments || '{}')
      console.log(`\x1b[33m${func_name}(${JSON.stringify(func_args)})\x1b[0m`)

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
  }
}

async function main() {
  try {
    console.log('s01: Agent Loop')
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
