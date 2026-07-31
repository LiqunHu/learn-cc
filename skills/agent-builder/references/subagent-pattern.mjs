/**
 * Subagent Pattern - How to implement Task tool for context isolation.
 *
 * Key insight: spawn child agents with ISOLATED context to prevent
 * "context pollution" where exploration details fill the main conversation.
 *
 * Assumes request() (gaxios), model, executeTool are defined elsewhere.
 */

// =============================================================================
// AGENT TYPE REGISTRY
// =============================================================================

export const AGENT_TYPES = {
  // Explore: Read-only, for searching and analyzing
  explore: {
    description: 'Read-only agent for exploring code, finding files, searching',
    tools: ['bash', 'read_file'], // No write access!
    prompt:
      'You are an exploration agent. Search and analyze, but NEVER modify files. Return a concise summary of what you found.',
  },

  // Code: Full-powered, for implementation
  code: {
    description: 'Full agent for implementing features and fixing bugs',
    tools: '*', // All tools
    prompt:
      'You are a coding agent. Implement the requested changes efficiently. Return a summary of what you changed.',
  },

  // Plan: Read-only, for design work
  plan: {
    description: 'Planning agent for designing implementation strategies',
    tools: ['bash', 'read_file'], // Read-only
    prompt:
      'You are a planning agent. Analyze the codebase and output a numbered implementation plan. Do NOT make any changes.',
  },

  // Add your own types here...
  // test: {
  //   description: 'Testing agent for running and analyzing tests',
  //   tools: ['bash', 'read_file'],
  //   prompt: "Run tests and report results. Don't modify code.",
  // },
}

export function getAgentDescriptions() {
  return Object.entries(AGENT_TYPES)
    .map(([name, cfg]) => `- ${name}: ${cfg.description}`)
    .join('\n')
}

export function getToolsForAgent(agentType, baseTools) {
  /**
   * Filter tools based on agent type.
   *
   * '*' means all base tools.
   * Otherwise, whitelist specific tool names.
   *
   * Note: Subagents don't get Task tool to prevent infinite recursion.
   */
  const allowed = AGENT_TYPES[agentType]?.tools ?? '*'

  if (allowed === '*') {
    return baseTools // All base tools, but NOT Task
  }

  return baseTools.filter((t) => allowed.includes(t.function.name))
}

// =============================================================================
// TASK TOOL DEFINITION
// =============================================================================

export function buildTaskTool() {
  return {
    type: 'function',
    function: {
      name: 'task',
      description: `Spawn a subagent for a focused subtask.

Subagents run in ISOLATED context - they don't see parent's history.
Use this to keep the main conversation clean.

Agent types:
${getAgentDescriptions()}

Example uses:
- task(explore): "Find all files using the auth module"
- task(plan): "Design a migration strategy for the database"
- task(code): "Implement the user registration form"
`,
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Short task name (3-5 words) for progress display',
          },
          prompt: {
            type: 'string',
            description: 'Detailed instructions for the subagent',
          },
          agent_type: {
            type: 'string',
            enum: Object.keys(AGENT_TYPES),
            description: 'Type of agent to spawn',
          },
        },
        required: ['description', 'prompt', 'agent_type'],
      },
    },
  }
}

// =============================================================================
// SUBAGENT EXECUTION
// =============================================================================

/**
 * Execute a subagent task with isolated context.
 *
 * Key concepts:
 * 1. ISOLATED HISTORY - subagent starts fresh, no parent context
 * 2. FILTERED TOOLS - based on agent type permissions
 * 3. AGENT-SPECIFIC PROMPT - specialized behavior
 * 4. RETURNS SUMMARY ONLY - parent sees just the final result
 *
 * @param {object} opts
 * @param {string} opts.description - Short name for progress display
 * @param {string} opts.prompt - Detailed instructions for subagent
 * @param {string} opts.agent_type - Key from AGENT_TYPES
 * @param {Function} opts.request - HTTP client (e.g. gaxios request)
 * @param {string} opts.url - Chat completions endpoint
 * @param {string} opts.apiKey - API key
 * @param {string} opts.model - Model to use
 * @param {string} opts.workdir - Working directory
 * @param {Array} opts.baseTools - List of tool definitions (without task)
 * @param {Function} opts.executeTool - Function to execute tools
 * @returns {Promise<string>} Final text output from subagent
 */
export async function runTask({
  description,
  prompt,
  agent_type: agentType,
  request,
  url,
  apiKey,
  model,
  workdir,
  baseTools,
  executeTool,
}) {
  if (!AGENT_TYPES[agentType]) {
    return `Error: Unknown agent type '${agentType}'`
  }

  const config = AGENT_TYPES[agentType]

  const subSystem = `You are a ${agentType} subagent at ${workdir}.

${config.prompt}

Complete the task and return a clear, concise summary.`

  const subTools = getToolsForAgent(agentType, baseTools)

  // KEY: ISOLATED message history!
  const subMessages = [{ role: 'user', content: prompt }]

  console.log(`  [${agentType}] ${description}`)
  const start = Date.now()
  let toolCount = 0
  let lastAssistant = null

  // Safety limit: max 30 turns
  for (let turn = 0; turn < 30; turn++) {
    const response = await request({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      data: {
        model,
        messages: [{ role: 'system', content: subSystem }, ...subMessages],
        tools: subTools,
      },
    })

    const assistant = response.data.choices[0].message
    lastAssistant = assistant
    subMessages.push(assistant)

    if (!assistant.tool_calls?.length) break

    for (const tc of assistant.tool_calls) {
      toolCount++
      const args = JSON.parse(tc.function.arguments || '{}')
      const output = await executeTool(tc.function.name, args)
      subMessages.push({ role: 'tool', content: output, tool_call_id: tc.id })

      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      process.stdout.write(
        `\r  [${agentType}] ${description} ... ${toolCount} tools, ${elapsed}s`,
      )
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  process.stdout.write(
    `\r  [${agentType}] ${description} - done (${toolCount} tools, ${elapsed}s)\n`,
  )

  // Parent sees ONLY the final text — clean summary
  return lastAssistant?.content || '(subagent returned no text)'
}

// =============================================================================
// USAGE EXAMPLE
// =============================================================================

/*
  // In your main agent's executeTool / TOOL_HANDLERS:

  async function executeTool(name, args) {
    if (name === 'task') {
      return runTask({
        description: args.description,
        prompt: args.prompt,
        agent_type: args.agent_type,
        request,
        url,
        apiKey,
        model,
        workdir: WORKDIR,
        baseTools: BASE_TOOLS, // without task
        executeTool,
      })
    }
    // ... other tools ...
  }

  // In your TOOLS list:
  const TOOLS = [...BASE_TOOLS, buildTaskTool()]
*/
