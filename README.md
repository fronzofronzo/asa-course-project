# ASA Course Project — Deliveroo.js Agent

BDI + LLM agents for the Autonomous Software Agents course, University of Trento (A.A. 2025-2026).

## Requirements

- Node.js 18+
- A valid `.env` file (see below)

## Setup

```bash
npm install
```

## Environment Variables

Create a `.env` file in the project root:

```env
# Required
HOST=<hostname>
TOKEN=<your_token>

# LLM agent 
LITELLM_BASE_URL=https://llm.bears.disi.unitn.it/v1
LITELLM_API_KEY=<your_key>
LOCAL_MODEL=llama-3.3-70b-lmstudio

# Mission sender filter (optional)
MISSION_SENDER=admin
```

## Running the BDI + LLM Agent

```bash
node src/bdi/agent.js
```

## Master / Slave Coordination

Two agents can cooperate using a master/slave protocol. Each agent needs its own `.env` file with a different `TOKEN`.

**Master** (coordinates, sends rendezvous commands):

```env
TOKEN=<master_token>
AGENT_ROLE=master
PEER_AGENT_NAME=<name_of_slave_agent>
PEER_AGENT_ID=<id_of_slave_agent>   # optional — resolved lazily from messages
```

**Slave** (executes coordination commands from master):

```env
TOKEN=<slave_token>
AGENT_ROLE=slave
PEER_AGENT_NAME=<name_of_master_agent>
PEER_AGENT_ID=<id_of_master_agent>  # optional
```

Launch both in separate terminals:

```bash
# terminal 1
node src/bdi/agent.js   # master .env loaded

# terminal 2
node src/bdi/agent.js   # slave .env loaded
```

`PEER_AGENT_ID` is optional: if omitted, it is resolved automatically the first time a message arrives from the peer.

## Logs

Log files are written to `./logs/` once the agent connects:

| File | Content |
|------|---------|
| `logs/agent-<name>.log` | Main agent loop, intentions, coordination |
| `logs/llm-<name>.log`   | LLM ReAct traces (llm_agent only) |
| `logs/utility-<name>.log` | Per-iteration desire utilities |

## Running the game in local 

When running the game locally, the agent requires a little timeout of 50 ms to avoid too fast movements. This behaviour can be modified in `agent.js`.