// The Agent Loop
//     +----------+      +-------+      +---------+
//     |   User   | ---> |  LLM  | ---> |  Tool   |
//     |  prompt  |      |       |      | execute |
//     +----------+      +---+---+      +----+----+
//                           ^               |
//                           |   tool_result |
//                           +---------------+
//                           (loop continues)

// This is the core loop: feed tool results back to the model
// until the model decides to stop. Production agents layer
// policy, hooks, and lifecycle controls on top.

import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
const { exec } = await import('node:child_process')
import { request } from 'gaxios'
const rl = readline.createInterface({ input, output })

const url = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
const apiKey = process.env.OPENAI_API_KEY || ''
const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo'

// ── Tool definition: just bash ────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command.",
      parameters: {
        command: {
          type: 'string',
          description: 'The shell command to execute, e.g. "ls -la" or "cat file.txt"',
        },
        required: ['command'],
      },
    }
  },
]

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`

async function run_bash({ command }) {
  return new Promise((resolve, reject) => {
    const dangerousCommands = ['rm', 'sudo', 'shutdown', 'reboot', 'mkfs', 'dd', '>:',  "> /dev/"]

    for (const dangerousCommand of dangerousCommands) {
      if (command.includes(dangerousCommand)) {
        return reject(`Error: Command "${dangerousCommand}" is not allowed.`)
      }
    }

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
      return
    }

    for (const tool_call of assistant_output.tool_calls) {
      const func_name = tool_call.function.name
      const func_args = JSON.parse(tool_call.function.arguments || '{}')
      console.log(`\x1b[33m${func_name}(${JSON.stringify(func_args)})\x1b[0m`)

      try {
        const tool_result = await run_bash(func_args)
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
