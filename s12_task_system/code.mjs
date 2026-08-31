// s12: Task System — file-persisted task graph with blockedBy dependencies.

// Changes from s11:
//   - Task dataclass (id, subject, description, status, owner, blockedBy)
//   - TASKS_DIR = .tasks/ for persistent JSON storage
//   - create_task / save_task / load_task / list_tasks / get_task
//   - can_start: checks blockedBy all completed (missing deps = blocked)
//   - claim_task: set owner + pending -> in_progress
//   - complete_task: set completed + report unblocked downstream
//   - 5 new tools: create_task, list_tasks, get_task, claim_task, complete_task

// Note: Teaching code keeps a basic agent loop to stay focused on the task
// system. S11's full error recovery (RecoveryState, backoff, escalation,
// reactive compact, fallback model) is omitted — in real CC, tasks.ts and
// withRetry are independent layers that compose naturally.

import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { exec } from 'node:child_process'
import { glob } from 'glob'
import { request } from 'gaxios'
import path from 'path'
import YAML from 'yaml'
import { randomInt } from 'node:crypto'

const rl = readline.createInterface({ input, output })

const url = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
const apiKey = process.env.OPENAI_API_KEY || ''
const model = process.env.OPENAI_MODEL || 'gpt-3.5-turbo'
const fallback_model = process.env.OPENAI_FALLBACK_MODEL || 'gpt-3.5-turbo'

const PWD = process.cwd()

const MEMORY_DIR = PWD + '/.memory'
const MEMORY_INDEX = MEMORY_DIR + '/MEMORY.md'
const SKILLS_DIR = PWD + '/skills'
const TRANSCRIPT_DIR = PWD + '/.transcripts'
const TOOL_RESULTS_DIR = PWD + '/.task_outputs/tool-results'

fs.mkdirSync(MEMORY_DIR, { recursive: true })
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true })
fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true })

let CURRENT_TODOS = []

// s12 ── Task System ──
const TASKS_DIR = PWD + '/.tasks'
fs.mkdirSync(TASKS_DIR, { recursive: true })

// class Task {
// 	id: String
// 	subject: String
// 	description: String
// 	status: String
// 	owner: String | null
// 	blockedBy: Array[String]
// }

function _task_path(task_id) {
	return TASKS_DIR + `/${task_id}.json`
}

async function create_task({ subject, description = '', blockedBy }) {
	const task = {
		id: `task_${Date.now()}_${randomInt(9999).padStart(4, '0')}}`,
		subject,
		description,
		status: 'pending',
		owner: null,
		blockedBy: blockedBy || [],
	}
	await save_task(task)
	return task
}

async function save_task(task) {
	await fsp.writeFile(_task_path(task.id), JSON.stringify(task))
}

async function load_task(task_id) {
	return JSON.parse(await fsp.readFile(_task_path(task_id)))
}

async function list_tasks() {
	const tasks = []
	for (const file of fs.globSync('task_*.json', { cwd: TASKS_DIR })) {
		tasks.push(JSON.parse(await fsp.readFile(TASKS_DIR + '/' + file)))
	}
	return JSON.stringify(tasks)
}

async function get_task({ task_id }) {
	// Return full task details as JSON.
	const task = await load_task(task_id)
	return JSON.stringify(task)
}

async function can_start(task_id) {
	// Check if all blockedBy dependencies are completed.
	// Missing dependencies are treated as blocked.
	const task = await load_task(task_id)
	for (let dep_id in task.blockedBy) {
		if (!fs.existsSync(_task_path(dep_id))) {
			return false
		}

		if ((await load_task(dep_id).status) != 'completed') {
			return false
		}
	}
	return true
}

async function claim_task({ task_id, owner = 'agent' }) {
	const task = await load_task(task_id)
	if (task.status == 'pending') {
		return `Task_${task_id} is ${task.status}, cannot claim`
	}

	if (!(await can_start(task_id))) {
		const deps = []
		for (let d in task.blockedBy) {
			if (!fs.existsSync(_task_path(d) || load_task(d).status != 'completed')) {
				deps.push(d)
			}
		}
		return `Blocked by: ${JSON.stringify(deps)}`
	}

	task.owner = owner
	task.status = 'in_progress'
	await save_task(task)
	console.log(`  \x1b[36m[claim] ${task.subject} → in_progress (owner: ${owner})\x1b[0m`)
	return `Claimed ${task.id} (${task.subject})`
}

async function complete_task({ task_id }) {
	const task = load_task(task_id)
	if (task.status != 'in_progress') {
		return `Task ${task_id} is ${task.status}, cannot complete`
	}
	task.status = 'completed'
	await save_task(task)
	const unblocked = []
	for (let t in await list_tasks()) {
		if (t.status == 'pending' && t.blockedBy && (await can_start(t.id))) {
			unblocked.push(t.subject)
		}
	}
	console.log(`  \x1b[32m[complete] ${task.subject} ✓\x1b[0m`)
	let msg = `Completed ${task.id} (${task.subject})`
	if (unblocked) {
		msg += `\nUnblocked: ${unblocked.join(', ')}`
		console.log(`  \x1b[33m[unblocked] ${unblocked.join(', ')}\x1b[0m`)
	}
	return msg
}

// NEW in s11: error recovery
// ── Constants ──
const ESCALATED_MAX_TOKENS = 64000
const DEFAULT_MAX_TOKENS = 8000
const MAX_RECOVERY_RETRIES = 3
const MAX_RETRIES = 10
const BASE_DELAY_MS = 500
const MAX_CONSECUTIVE_529 = 3
const CONTINUATION_PROMPT = `Output token limit hit. Resume directly — 
no apology, no recap. Pick up mid-thought.`

// class RecoveryState {
// 	has_escalated: Boolean
// 	recovery_count: Number
// 	consecutive_529: Number
// 	has_attempted_reactive_compact: Boolean
// 	current_model: String
// }

function sleep(s) {
	return new Promise((resolve) => setTimeout(resolve, s * 1000))
}

function retry_delay(attempt, retry_after = null) {
	// Exponential backoff with jitter. Retry-After takes priority.
	if (retry_after != null) {
		return retry_after
	}

	const base_tmp = BASE_DELAY_MS * 2 ** attempt
	const base = (base_tmp > 32000 ? base_tmp : 32000) / 1000
	const jitter = randomInt(1, base * 25) / 100

	return base + jitter
}
async function with_retry(fn, state) {
	// Exponential backoff for transient errors (429/529).
	// Non-transient errors are re-raised for the outer handler.
	for (let i = 0; i < MAX_RETRIES; i++) {
		try {
			const result = await fn
			state.consecutive_529 = 0
			return result
		} catch (error) {
			const msg = error.message.toLowerCase()
			// # 429 rate limit -> exponential backoff
			if (msg.indexof('ratelimit') >= 0 || msg.indexof('429') >= 0) {
				const delay = retry_delay(attempt)
				console.log(`  \x1b[33m[429 rate limit] retry ${attempt + 1}/${MAX_RETRIES},
wait ${delay.fix(1)}s\x1b[0m`)
				await sleep(delay)
				continue
			}

			//  # 529 overloaded -> exponential backoff + fallback model
			if (msg.indexof('overloaded') >= 0 || msg.indexof('529') >= 0) {
				state.consecutive_529 += 1
				if (fallback_model) {
					state.current_model = FALLBACK_MODEL
					state.consecutive_529 = 0
					console.log(` \x1b[31m[529 ${MAX_CONSECUTIVE_529}],
switching to ${fallback_model}\x1b[0m`)
				} else {
					state.consecutive_529 = 0
					console.log(` \x1b[31m[529 ${MAX_CONSECUTIVE_529}],
no FALLBACK_MODEL_ID configured, continuing retry\x1b[0m`)
				}
				delay = retry_delay(attempt)
				await sleep(delay)
				continue
			}
			throw error
		}
	}

	throw `Max retries (${MAX_RETRIES}) exceeded`
}

function is_prompt_too_long_error(error) {
	// Check whether an API error indicates prompt/context too long.
	const msg = error.message.toLowerCase()
	return
	;(msg.indexof('prompt') >= 0 && msg.indexof('long') >= 0) ||
		msg.indexof('prompt_is_too_long') >= 0 ||
		msg.indexof('context_length_exceeded') >= 0 ||
		msg.indexof('max_context_window') >= 0
}

// NEW in s09: system prompt
// ── Prompt Sections ──
const PROMPT_SECTIONS = {
	identity: "You are a coding agent. Act, don't explain.",
	tools: 'Available tools: bash, read_file, write_file.',
	workspace: `Working directory: ${PWD}`,
	memory: 'Relevant memories are injected below when available.',
}

function assemble_system_prompt(context) {
	// Select and join prompt sections based on current context.
	const sections = []

	// Always loaded — identity, tools, workspace
	sections.push(PROMPT_SECTIONS['identity'])
	sections.push(PROMPT_SECTIONS['tools'])
	sections.push(PROMPT_SECTIONS['workspace'])

	// Conditional — memory loaded when MEMORY.md exists and has content
	if (context['memories']) {
		sections.push(`Relevant memories:
${context['memories']}`)
	}

	return sections.join('\n\n')
}

let _last_context_key = null
let _last_prompt = null

function get_system_prompt(context) {
	// Cache wrapper — reassemble only when context changes.

	// which has process randomization and fails on nested dicts/lists.
	// This cache only avoids redundant string assembly within a process.
	// Real Claude Code additionally protects API-level prompt cache via
	// stable section ordering and SYSTEM_PROMPT_DYNAMIC_BOUNDARY.

	const key = JSON.stringify(context)
	if (key === _last_context_key && _last_prompt) {
		console.log(' \x1b[90m[cache hit] system prompt unchanged\x1b[0m')
		return _last_prompt
	}

	_last_context_key = key
	_last_prompt = assemble_system_prompt(context)

	const loaded = ['identity', 'tools', 'workspace']

	if (context['memories']) {
		loaded.push('memory')
	}

	console.log(` \x1b[32m[assembled] sections:  ${loaded.join(', ')}\x1b[0m`)
	return _last_prompt
}

function update_context(context, messages) {
	// Derive context from real state: which tools exist, whether memory files exist.
	let memories = read_memory_index()
	// if(memories){
	// 	context = memories
	// }

	return {
		enabled_tools: Object.keys(TOOL_HANDLERS),
		workspace: PWD,
		memories,
	}
}

// NEW in s09: Memory System
const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']

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

async function _rebuild_index() {
	// Rebuild MEMORY.md index from all memory files.
	const lines = []
	for (const file of fs.globSync('*.md', { cwd: MEMORY_DIR })) {
		if (file === 'MEMORY.md') continue
		const raw = await fsp.readFile(`${MEMORY_DIR}/${file}`, 'utf8')
		const { meta, body } = _parse_frontmatter(raw)
		const name = meta['name'] || path.dirname(file)
		const desc = meta['description'] || body.split('\n')[0].slice(0, 80).trim()
		lines.push(`- [${name}](${file}) — ${desc}`)
	}
	await fsp.writeFile(MEMORY_INDEX, lines.length > 0 ? lines.join('\n') : '', { encoding: 'utf-8' })
}

async function write_memory_file({ name, mem_type, description, body }) {
	// Write a single memory file with YAML frontmatter.
	const slug = name.toLowerCase().replace(/\s+/g, '-').replace('/', '-')
	const filename = `${slug}.md`
	const filepath = `${MEMORY_DIR}/${filename}`
	const frontmatter = `---\nname: ${name}\ndescription: ${description}\ntype: ${mem_type}\n---\n\n${body}\n`
	await fsp.writeFile(filepath, frontmatter, { encoding: 'utf-8' })
	await _rebuild_index()
	return filepath
}

async function read_memory_index() {
	// Read MEMORY.md index (injected into SYSTEM every turn).
	if (fs.existsSync(MEMORY_INDEX)) {
		const raw = fsp.readFile(MEMORY_INDEX, 'utf8')
		return raw
	} else {
		return ''
	}
}

async function read_memory_file(filename) {
	// Read a single memory file's full content.
	const path = `${MEMORY_DIR}/${filename}`
	if (fs.existsSync(path)) {
		const raw = await fsp.readFile(path, 'utf8')
		return raw
	} else {
		return null
	}
}

async function list_memory_files() {
	// List all memory files with metadata.
	const result = []

	for (const file of fs.globSync('*.md', { cwd: MEMORY_DIR })) {
		if (file === 'MEMORY.md') continue
		const raw = await fsp.readFile(`${MEMORY_DIR}/${file}`, 'utf8')
		const { meta, body } = _parse_frontmatter(raw)
		result.push({
			filename: file,
			name: meta['name'] || path.dirname(file),
			description: meta['description'] || '',
			type: meta['type'] || 'user',
			body,
		})
	}
	return result
}

async function select_relevant_memories(messages, max_items = 5) {
	// Select relevant memory filenames by matching recent conversation against
	// memory names/descriptions. Uses a simple LLM call (or falls back to keyword
	// matching on name+description).
	const files = await list_memory_files()
	if (files.length === 0) {
		return []
	}

	// Collect recent user text for context
	const recent_texts = []
	for (let i = messages.length - 1; i >= 0 && recent_texts.length < 5; i--) {
		if (messages[i].role === 'user') {
			recent_texts.push(messages[i].content)
		}
		if (recent_texts.length >= 3) break
	}

	const recent = recent_texts
		.reverse()
		.map((t) => t.slice(0, 2000))
		.join(' ')

	if (recent.trim().length === 0) {
		return []
	}

	// Build catalog of name + description for LLM to choose from
	const catalog_lines = []
	files.map((f, i) => {
		catalog_lines.push(`${i}: ${f['name']} — ${f['description']}`)
	})

	const catalog = catalog_lines.join('\n')

	const prompt = `Given the recent conversation and the memory catalog below,
  select the indices of memories that are clearly relevant.
  Return ONLY a JSON array of integers, e.g. [0, 3].
  If none are relevant, return [].


  Recent conversation:
  ${recent}


  Memory catalog:
  ${catalog}
  `

	let state = {
		has_escalated: false,
		recovery_count: 0,
		consecutive_529: 0,
		has_attempted_reactive_compact: false,
		current_model: model,
	}

	try {
		const response = await with_retry(
			request({
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
					max_tokens: 200,
				},
			}),
			state,
		)

		const assistant_output = response.data.choices[0].message
		const match = assistant_output.content.match(/\[.*?\]/s)
		if (match) {
			const indices = JSON.parse(match[0])
			const selected = []
			for (const i of indices) {
				if (i >= 0 && i < files.length) {
					selected.push(files[i]['filename'])
				}
			}
			return selected
		}
	} catch (error) {
		console.log(error)
	}

	// Fallback: keyword matching on name + description
	const keywords = recent
		.toLowerCase()
		.split(/\W+/)
		.filter((w) => w.length > 3)
	const selected = []
	for (const f of files) {
		const text = `${f['name']} ${f['description']}`.toLowerCase()
		if (keywords.some((kw) => text.includes(kw))) {
			selected.push(f['filename'])
		}
	}
	return selected
}

async function load_memories(messages) {
	// Load relevant memory content for injection into context.
	const selected_files = await select_relevant_memories(messages)
	if (selected_files.length === 0) {
		return ''
	}

	const parts = ['<relevant_memories>']
	for (const filename of selected_files) {
		const content = await read_memory_file(filename)
		if (content) {
			parts.push(content)
		}
	}
	parts.push('</relevant_memories>')
	return parts.join('\n\n')
}

async function extract_memories(messages) {
	// Extract new memories from recent dialogue. Runs after each turn.

	// Collect recent conversation text
	const dialogue_parts = []
	for (let i = messages.length > 10 ? messages.length - 10 : 0; i < messages.length; i++) {
		if (messages[i].content.trim().length != 0) {
			dialogue_parts.push(`${messages[i].role}: ${messages[i].content}`)
		}
	}
	const dialogue = dialogue_parts.join('\n')
	if (dialogue.trim().length === 0) {
		return null
	}

	// Check existing memories to avoid duplicates
	const existing = await list_memory_files()
	const existing_texts = existing.map((f) => `- ${f.name}: ${f.description}`.toLowerCase()).join('\n') || '(none)'

	const prompt = `Extract user preferences, constraints, or project facts from this dialogue.
  Return a JSON array. Each item: {name, type, description, body}.
  - name: short kebab-case identifier (e.g. 'user-preference-tabs')
  - type: one of 'user' (user preference), 'feedback' (guidance),
  'project' (project fact), 'reference' (external pointer)
  - description: one-line summary for index lookup
  - body: full detail in markdown
  If nothing new or already covered by existing memories, return [].

  Existing memories:
  ${existing_texts}

  Dialogue:
  ${dialogue.slice(0, 4000)}`
	let state = {
		has_escalated: false,
		recovery_count: 0,
		consecutive_529: 0,
		has_attempted_reactive_compact: false,
		current_model: model,
	}

	try {
		const response = await with_retry(
			request({
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
					max_tokens: 800,
				},
			}),
			state,
		)

		const assistant_output = response.data.choices[0].message
		const match = assistant_output.content.match(/\[.*?\]/s)
		if (match) {
			const items = JSON.parse(match[0])
			if (!Array.isArray(items)) {
				return []
			}
			let count = 0
			for (const item of items) {
				const name = item.name || `memory-${Date.now()}`
				const mem_type = item.type || 'user'
				const description = item.description || ''
				const body = item.body || ''
				if (description.trim().length > 0 && body.trim().length > 0) {
					await write_memory_file({ name, mem_type, description, body })
					count += 1
				}
				if (count > 0) {
					console.log(`\x1b[32m[Memory: extracted${count} new memories]\x1b[0m`)
				}
			}
		}
	} catch (error) {
		console.log(error)
	}
}

const CONSOLIDATE_THRESHOLD = 10
async function consolidate_memories() {
	// Merge duplicate/stale memories. Triggered when file count ≥ threshold.
	const files = await list_memory_files()
	if (files.length < CONSOLIDATE_THRESHOLD) {
		return
	}
	const catalog = files
		.map(
			(f) => `## ${f['filename']}
name:${f['name']}
description:${f['description']}
${f['body']}`,
		)
		.join('\n\n"')

	const prompt = `Consolidate the following memory files. Rules:
    1. Merge duplicates into one
    2. Remove outdated/contradicted memories
    3. Keep the total under 30 memories
    4. Preserve important user preferences above all
    Return a JSON array. Each item: {name, type, description, body}.

    ${catalog.slice(0, 16000)}
    `

	let state = {
		has_escalated: false,
		recovery_count: 0,
		consecutive_529: 0,
		has_attempted_reactive_compact: false,
		current_model: model,
	}

	try {
		const response = await with_retry(
			request({
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
					max_tokens: 3000,
				},
			}),
			state,
		)

		const assistant_output = response.data.choices[0].message
		const match = assistant_output.content.match(/\[.*?\]/s)
		if (match) {
			const items = JSON.parse(match[0])

			// Remove old memory files (keep MEMORY.md)
			for await (const file of fs.globSync('*.md', { cwd: MEMORY_DIR })) {
				if (file !== 'MEMORY.md') {
					await fsp.unlink(`${MEMORY_DIR}/${file}`)
				}
			}

			for (const mem of items) {
				const name = mem.name || `memory-${Date.now()}`
				const mem_type = mem.type || 'user'
				const description = mem.description || ''
				const body = mem.body || ''
				if (description.trim().length > 0 && body.trim().length > 0) {
					await write_memory_file({ name, mem_type, description, body })
				}
			}

			console.log(`\x1b[32m[Memory: consolidated ${files.length - items.length} memories]\x1b[0m`)
		}
	} catch (error) {
		console.log(error)
	}
}

// Build SYSTEM with memory index
async function build_system() {
	const index = await read_memory_index()
	const catalog = list_skills()
	const memories_section = index ? `Memories available:\n${index}` : ''
	return `You are a coding agent at ${PWD}, Use tools to solve tasks.

Skills available:
${catalog}
Use load_skill to get full details when needed.

${memories_section}
Relevant memories are injected below. Respect user preferences from memory.
When the user says 'remember' or expresses a clear preference, extract it as a memory.`
}

// s07: Skill catalog scan (used by build_system below)
// Parse YAML frontmatter from SKILL.md. Returns (meta, body)

// Build skill registry at startup (used for safe lookup in load_skill)
const SKILL_REGISTRY = {}

// Scan skills/ dir, populate SKILL_REGISTRY with name/description/content.
async function _scan_skills() {
	try {
		for await (const file of fs.globSync('**/**/*.md', { cwd: SKILLS_DIR })) {
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
		const data = await fsp.readFile(safe_path, { encoding: 'utf-8' })
		return data.split('\n').slice(0, limit).join('\n')
	} catch (error) {
		throw new Error(`Error: ${error.message}`)
	}
}

async function run_write_file({ path, content }) {
	try {
		const safe_path = safePath(path)
		await fsp.writeFile(safe_path, content, { encoding: 'utf-8' })
		return `Wrote to ${safe_path}`
	} catch (error) {
		throw new Error(`Error: ${error.message}`)
	}
}

async function run_edit_file({ path, old_text, new_text }) {
	try {
		const safe_path = safePath(path)
		let data = await fsp.readFile(safe_path, { encoding: 'utf-8' })
		if (!data.includes(old_text)) {
			throw new Error(`Text "${old_text}" not found in file.`)
		}
		data = data.replace(old_text, new_text)
		await fsp.writeFile(safe_path, data, { encoding: 'utf-8' })
		return `Edited ${safe_path}`
	} catch (error) {
		throw new Error(`Error: ${error.message}`)
	}
}

async function run_glob({ pattern, cwd, ignore, dot, nodir, absolute, maxDepth, nocase, follow }) {
	try {
		const extraIgnore = ignore == null ? [] : Array.isArray(ignore) ? ignore : [ignore]
		const files = await globSync(pattern, {
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
	{
		type: 'function',
		function: {
			name: 'create_task',
			description: 'Create a new task with optional blockedBy dependencies.',
			parameters: {
				subject: {
					type: 'string',
					description: 'subject of the task',
				},
				description: {
					type: 'string',
					description: 'description of the task',
				},
				blockedBy: {
					type: 'array',
					items: {
						type: 'string',
						description: 'ID of the task that is blocked by the current task',
					},
				},
				required: ['subject'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_tasks',
			description: 'List all tasks with status, owner, and dependencies.',
			parameters: {
				required: [],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_task',
			description: 'Get full details of a specific task by ID.',
			parameters: {
				task_id: {
					type: 'string',
					description: 'ID of the task',
				},
				required: ['task_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'claim_task',
			description: 'Claim a pending task. Sets owner, changes status to in_progress.',
			parameters: {
				task_id: {
					type: 'string',
					description: 'ID of the task',
				},
				required: ['task_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'complete_task',
			description: 'Complete an in-progress task. Reports unblocked downstream tasks.',
			parameters: {
				task_id: {
					type: 'string',
					description: 'ID of the task',
				},
				required: ['task_id'],
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
	create_task: create_task,
	list_tasks: list_tasks,
	get_task: get_task,
	claim_task: claim_task,
	complete_task: complete_task,
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

	let state = {
		has_escalated: false,
		recovery_count: 0,
		consecutive_529: 0,
		has_attempted_reactive_compact: false,
		current_model: model,
	}

	//safety limit
	for (let i = 0; i < 30; i++) {
		try {
			const response = await with_retry(
				request({
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
				}),
				state,
			)

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
async function persist_large_output(tool_call_id, content) {
	if (content.length <= PERSIST_THRESHOLD) {
		return content
	}
	const filename = `${TOOL_RESULTS_DIR}/${tool_call_id}.txt`
	await fsp.writeFile(filename, content)
	return `<persisted-output>\nFull output: ${filename}\nPreview:\n${content.substring(0, 2000)}\n</persisted-output>`
}

async function tool_result_budget(messages, max_bytes = 200_000) {
	const last = messages[messages.length - 1]
	if (!last || last['role'] != 'user') return messages

	const total = messages.reduce((acc, msg) => acc + msg['content'].length, 0)
	if (total <= max_bytes) {
		return messages
	}

	messages.map(async (msg) => {
		if (msg['role'] == 'tool' && msg['tool_call_id']) {
			msg['content'] = await persist_large_output(msg['tool_call_id'], msg['content'])
		}
	})
	return messages
}

// L4: autoCompact — LLM full summary
async function write_transcript(messages) {
	const path = `${TRANSCRIPT_DIR}/transcript-${Date.now()}.json`
	fsp.writeFile(path, JSON.stringify(messages))
	return path
}

async function summarize_history(messages) {
	const conversation = JSON.stringify(messages).slice(0, 80000)
	const prompt = `Summarize this coding-agent conversation so work can continue.
Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed,
4. remaining work, 5. user constraints.
Be compact but concrete.


${conversation}`

	let state = {
		has_escalated: false,
		recovery_count: 0,
		consecutive_529: 0,
		has_attempted_reactive_compact: false,
		current_model: model,
	}

	const response = await with_retry(
		request({
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
				max_tokens: 2000,
			},
		}),
		state,
	)

	const assistant_output = response.data.choices[0].message
	return assistant_output.content || '(empty summary)'
}

async function compact_history(messages) {
	const transcript_path = await write_transcript(messages)
	console.log(`[transcript saved: ${transcript_path}]`)
	const summary = await summarize_history(messages)
	return [{ role: 'assistant', content: `[Compacted]\n\n${summary}` }]
}

// Emergency: reactiveCompact — on API error
async function reactive_compact(messages) {
	const transcript = await write_transcript(messages)
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

async function agent_loop(message, context) {
	let reactive_retries = 0
	// s09: inject relevant memory content into the current user turn
	let memories_content = await load_memories(message)
	let memory_turn = message.length > 0 ? message.length - 1 : null
	// const system = build_system()
	let system = get_system_prompt(context)

	let state = {
		has_escalated: false,
		recovery_count: 0,
		consecutive_529: 0,
		has_attempted_reactive_compact: false,
		current_model: model,
	}

	while (true) {
		// s09: save pre-compression snapshot for accurate memory extraction
		const pre_compress = message.map((msg) => ({ ...msg }))

		// s08 change: three preprocessors (0 API calls, cheap first)
		// Order matches CC source: budget → snip → micro
		message = await tool_result_budget(message)
		message = snip_compact(message)
		message = micro_compact(message)

		// s08 change: tokens still over threshold → LLM summary (1 API call)
		if (estimate_size(message) > CONTEXT_LIMIT) {
			console.log('[auto compact]')
			message = await compact_history(message)
		}
		try {
			let request_messages = JSON.parse(JSON.stringify(message))
			if (memories_content && memory_turn !== null && memory_turn < message.length) {
				request_messages[memory_turn] = {
					...request_messages[memory_turn],
					content: `${memories_content}
          
          ${message[memory_turn]['content']}`,
				}
			}

			const response = await with_retry(
				request({
					url: `${url}`,
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'Content-Type': 'application/json',
					},
					data: {
						model: model,
						messages: [{ role: 'system', content: system }, ...request_messages],
						max_tokens: 8000,
						enable_thinking: false,
						tools: TOOLS,
					},
				}),
				state,
			)

			reactive_retries = 0
			const assistant_output = response.data.choices[0].message
			message.push(assistant_output)
			// If the model didn't call a tool, we're done
			if (!assistant_output.tool_calls) {
				let force = await trigger_hooks('Stop', message)
				if (force) {
					message.push({ role: 'user', content: force })
					continue
				}
				await extract_memories(pre_compress)
				await consolidate_memories()
				return
			}

			for (const tool_call of assistant_output.tool_calls) {
				const func_name = tool_call.function.name
				const func_args = JSON.parse(tool_call.function.arguments || '{}')
				console.log(`\x1b[33m${func_name}(${JSON.stringify(func_args)})\x1b[0m`)

				// s08: compact tool triggers compact_history, not a no-op string
				if (func_name === 'compact') {
					message = await compact_history(message)
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
			if (
				(error.message.toLowerCase().includes('prompt_too_long') || error.message.toLowerCase().includes('too many tokens')) &&
				reactive_retries < MAX_REACTIVE_RETRIES
			) {
				console.log('[reactive compact]')
				message = await reactive_compact(message)
				reactive_retries += 1
				continue
			} else {
				console.error('Error fetching data:', error)
				return
			}
		}

		// Re-evaluate context and prompt after each tool round
		context = update_context(context, message)
		system = get_system_prompt(context)
	}
}

async function main() {
	try {
		console.log('s08: Context Compact — four-layer compaction pipeline')
		console.log('输入问题，回车发送。输入 q 退出。\n')

		const history = []
		let context = update_context({}, [])
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
			await agent_loop(history, context)
			context = update_context(context, history)
			// Print the model's final text response
			const response_content = history[history.length - 1]?.content
			if (response_content) {
				console.log(response_content)
			}
		}
		rl.close()
	} catch (error) {
		console.error('Error fetching data:', error)
	}
}

main()
