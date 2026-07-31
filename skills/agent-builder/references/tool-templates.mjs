/**
 * Tool Templates - Copy and customize these for your agent.
 *
 * Each tool needs:
 * 1. Definition (JSON schema for the model — OpenAI tools format)
 * 2. Implementation (async Node.js function)
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)
const WORKDIR = process.cwd()

// =============================================================================
// TOOL DEFINITIONS (for TOOLS list)
// =============================================================================

export const BASH_TOOL = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a shell command. Use for: ls, find, grep, git, npm, node, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
      },
      required: ['command'],
    },
  },
}

export const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read file contents. Returns UTF-8 text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file' },
        limit: { type: 'integer', description: 'Max lines to read (default: all)' },
      },
      required: ['path'],
    },
  },
}

export const WRITE_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path for the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
}

export const EDIT_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Replace exact text in a file. Use for surgical edits.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file' },
        old_text: { type: 'string', description: 'Exact text to find (must match precisely)' },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
}

export const TODO_WRITE_TOOL = {
  type: 'function',
  function: {
    name: 'todo_write',
    description: 'Update the task list. Use to plan and track progress.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Complete list of tasks',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Task description' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
}

/*
  Generate TASK tool dynamically with agent types:

  {
    type: 'function',
    function: {
      name: 'task',
      description: `Spawn a subagent for a focused subtask.\n\nAgent types:\n${getAgentDescriptions()}`,
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short task name (3-5 words)' },
          prompt: { type: 'string', description: 'Detailed instructions' },
          agent_type: { type: 'string', enum: Object.keys(AGENT_TYPES) },
        },
        required: ['description', 'prompt', 'agent_type'],
      },
    },
  }
*/

// =============================================================================
// TOOL IMPLEMENTATIONS
// =============================================================================

export function safePath(p) {
  /**
   * Security: Ensure path stays within workspace.
   * Prevents ../../../etc/passwd attacks.
   */
  const resolved = path.resolve(WORKDIR, p)
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`)
  }
  return resolved
}

export async function runBash(command) {
  /**
   * Execute shell command with safety checks.
   * - Blocks obviously dangerous commands
   * - 60 second timeout
   * - Output truncated to 50KB
   */
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/']
  if (dangerous.some((d) => command.includes(d))) {
    return 'Error: Dangerous command blocked'
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 60_000,
      maxBuffer: 50_000,
    })
    const output = (stdout + stderr).trim()
    return output ? output.slice(0, 50_000) : '(no output)'
  } catch (e) {
    if (e.killed) return 'Error: Command timed out (60s)'
    return `Error: ${e.message}`
  }
}

export async function runReadFile(filePath, limit = null) {
  try {
    const text = await fs.readFile(safePath(filePath), 'utf-8')
    let lines = text.split('\n')

    if (limit != null && limit < lines.length) {
      const remaining = lines.length - limit
      lines = lines.slice(0, limit)
      lines.push(`... (${remaining} more lines)`)
    }

    return lines.join('\n').slice(0, 50_000)
  } catch (e) {
    return `Error: ${e.message}`
  }
}

export async function runWriteFile(filePath, content) {
  try {
    const fp = safePath(filePath)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, content, 'utf-8')
    return `Wrote ${content.length} bytes to ${filePath}`
  } catch (e) {
    return `Error: ${e.message}`
  }
}

export async function runEditFile(filePath, oldText, newText) {
  try {
    const fp = safePath(filePath)
    let content = await fs.readFile(fp, 'utf-8')

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`
    }

    content = content.replace(oldText, newText)
    await fs.writeFile(fp, content, 'utf-8')
    return `Edited ${filePath}`
  } catch (e) {
    return `Error: ${e.message}`
  }
}

// =============================================================================
// DISPATCHER PATTERN
// =============================================================================

export async function executeTool(name, args) {
  /**
   * Dispatch tool call to implementation.
   *
   * Add a new tool:
   * 1. Add definition to TOOLS list
   * 2. Add implementation function
   * 3. Add case to this dispatcher
   */
  if (name === 'bash') return runBash(args.command)
  if (name === 'read_file') return runReadFile(args.path, args.limit)
  if (name === 'write_file') return runWriteFile(args.path, args.content)
  if (name === 'edit_file') return runEditFile(args.path, args.old_text, args.new_text)
  return `Unknown tool: ${name}`
}
