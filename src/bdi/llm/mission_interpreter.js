import 'dotenv/config'
import OpenAI from 'openai'
import { logLLM } from '../logger.js'

const baseURL = process.env.LITELLM_BASE_URL ?? 'https://llm.bears.disi.unitn.it/v1'
const apiKey  = process.env.LITELLM_API_KEY
const MODEL   = process.env.LOCAL_MODEL ?? 'llama-3.3-70b-lmstudio'

let client = null
if (!apiKey) {
    logLLM('[MissionInterpreter] WARNING: LITELLM_API_KEY not set — LLM features disabled')
} else {
    client = new OpenAI({ baseURL, apiKey })
}

// ─── ReAct helpers (copied from llm_agent.js — cannot import that file, it runs process.exit at scope) ───

async function callModel(messages, { temperature = 0 } = {}) {
    const response = await client.chat.completions.create({ model: MODEL, messages, temperature })
    return response.choices?.[0]?.message?.content ?? ''
}

function extractAction(text) {
    const actionMatch = text.match(/^Action:\s*(.+)$/im)
    if (!actionMatch) return null
    const actionInputMatch = text.match(/^Action Input:\s*(.*)$/im)
    return {
        action: actionMatch[1].trim(),
        actionInput: actionInputMatch ? actionInputMatch[1].trim() : '',
    }
}

function extractFinalAnswer(text) {
    const match = text.match(/^Final Answer:\s*([\s\S]*)$/im)
    return match ? match[1].trim() : null
}

// ─── Tool helpers ───

function calculate(expression) {
    try {
        return String(eval(expression))
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function getAgentState(beliefs, getState) {
    try {
        const { x, y, score } = getState()
        if (x === null) return 'Error: agent position not available yet'
        return JSON.stringify({
            x, y, score,
            mapInfo: {
                deliveryTilesCount: beliefs.map.deliveryTiles.length,
                spawnTilesCount: beliefs.map.spawnTiles.length,
            },
        })
    } catch (e) {
        return `Error: ${e.message}`
    }
}

function setTileUtility(input, beliefs) {
    try {
        const { x, y, utility } = JSON.parse(input)
        if (typeof x !== 'number' || typeof y !== 'number' || typeof utility !== 'number') {
            return 'Error: x, y, and utility must be numbers. Expected JSON: {"x": N, "y": N, "utility": N}'
        }
        if (utility <= 0) {
            return 'Error: utility must be a positive number — do not call this for negative-reward missions'
        }
        const key = `${Math.round(x)},${Math.round(y)}`
        beliefs.tileUtilities.set(key, utility)
        return `Tile utility set: (${Math.round(x)},${Math.round(y)}) = ${utility}`
    } catch (e) {
        return `Error: invalid JSON input. Expected: {"x": N, "y": N, "utility": N}. Got: ${input}`
    }
}

function replyToSender(message, replyFn) {
    if (!replyFn) return 'Error: no reply channel available'
    try {
        replyFn(message)
        return `Replied: ${message}`
    } catch (e) {
        return `Error: reply failed: ${e.message}`
    }
}

// ─── System prompt ───

const MISSION_SYSTEM_PROMPT = `
You are an AI assistant embedded in a BDI agent playing a parcel delivery game (Deliveroo.js).
Your ONLY job is to interpret special mission messages and use tools to configure the agent's behaviour.

== GAME CONTEXT ==
Grid-based game. Coordinates: right=x+1, up=y+1. Agent collects parcels from spawn tiles and delivers them to delivery tiles to earn points.
Setting a tile utility directs the BDI agent to move to that tile — it competes with normal parcel pick-up in deliberation.

== TOOLS ==
1. get_agent_state
   Input: (empty string)
   Returns: JSON {x, y, score, mapInfo: {deliveryTilesCount, spawnTilesCount}}

2. calculate
   Input: a math expression string, e.g. "4*2" or "(1+3)*3"
   Returns: the computed result as a string, or an error string.

3. set_tile_utility
   Input: JSON string {"x": N, "y": N, "utility": N}
   Action: directs the BDI agent to navigate to tile (x, y) with given priority.
   Constraint: utility MUST be a positive number. Never call this for negative or zero reward missions.

4. reply_to_sender
   Input: a plain text message string
   Action: sends a message back to the agent who sent this mission.

== MISSION HANDLING RULES ==

RULE 1 — Always call get_agent_state first to understand the current game context.

RULE 2 — GOTO mission ("move to (x,y) and get +N pts"):
  - If coordinates contain math expressions (e.g. x=4*2), call calculate for each expression first.
  - If reward > 0: call set_tile_utility({"x": x, "y": y, "utility": reward}), then Final Answer "Mission accepted: going to (x,y) for +N pts"
  - If reward <= 0: do NOT call set_tile_utility. Final Answer: "Mission rejected: negative/zero reward"

RULE 3 — Knowledge/question mission ("what is X? send answer to agent who sent the prompt"):
  - Answer the question and call reply_to_sender with your answer.
  - Then give Final Answer summarising what you replied.

RULE 4 — Utility value must equal the exact numerical reward stated in the mission (e.g. "+10pts" → utility 10).
  Do not scale, round up, or invent the utility value.

== OUTPUT FORMAT — choose exactly one per message ==

FORMAT A — use a tool:
Thought: <brief reasoning>
Action: <tool_name>
Action Input: <tool input>

FORMAT B — mission complete:
Thought: <brief reasoning>
Final Answer: <outcome summary>

Never output Action and Final Answer in the same message. Never write "Action: None". Do not invent tool results.
`.trim()

// ─── Main export ───

export async function interpretMission(senderName, msg, beliefs, getState, replyFn) {
    if (!client) {
        logLLM('[MissionInterpreter] No LLM client — skipping mission interpretation')
        return
    }

    logLLM(`[MissionInterpreter] Interpreting mission from ${senderName}: "${msg}"`)

    const TOOLS = {
        get_agent_state: (_input) => getAgentState(beliefs, getState),
        calculate:       (input)  => calculate(input),
        set_tile_utility:(input)  => setTileUtility(input, beliefs),
        reply_to_sender: (input)  => replyToSender(input, replyFn),
    }

    const messages = [
        { role: 'system', content: MISSION_SYSTEM_PROMPT },
        { role: 'user',   content: `[MISSION from ${senderName}]: "${msg}"` },
    ]

    for (let i = 0; i < 8; i++) {
        logLLM(`[MissionInterpreter] --- iteration ${i + 1} ---`)

        const assistantText = await callModel(messages, { temperature: 0 })
        logLLM(`[MissionInterpreter] output:\n${assistantText}`)
        messages.push({ role: 'assistant', content: assistantText })

        const finalAnswer = extractFinalAnswer(assistantText)
        if (finalAnswer !== null) {
            logLLM(`[MissionInterpreter] Final Answer: ${finalAnswer}`)
            return
        }

        const parsed = extractAction(assistantText)
        if (parsed === null) {
            messages.push({
                role: 'user',
                content: 'Observation: Error: invalid format. Output exactly one Action (with Action Input) or one Final Answer.',
            })
            continue
        }

        const { action, actionInput } = parsed
        let observation
        if (TOOLS[action]) {
            try {
                observation = await TOOLS[action](actionInput)
            } catch (e) {
                observation = `Error: tool threw: ${e.message}`
            }
        } else {
            observation = `Error: unknown tool '${action}'. Available: ${Object.keys(TOOLS).join(', ')}`
        }

        logLLM(`[MissionInterpreter] tool=${action} input="${actionInput}" → ${observation}`)
        messages.push({
            role: 'user',
            content: `Observation: ${observation}\n\nContinue. If all tool calls are done, give Final Answer. Output exactly one Action or one Final Answer.`,
        })
    }

    logLLM('[MissionInterpreter] WARNING: max iterations reached without Final Answer')
}
