# Mission Constraints — Plugin/Registry Pattern

## Design Patterns Used

This system combines three classical patterns:

- **Plugin / Strategy**: each constraint is an independent class with the same interface (`Constraint`). New constraints can be added without touching any existing code — this is the **Open/Closed Principle** from SOLID.

- **Registry**: `MissionConstraints` holds a list of all active plugins and acts as the single access point. Callers never know which constraints exist; they only talk to the registry.

- **Chain of Responsibility**: operations like `checkPickup`, `checkPutdown`, and `computeEV` walk the list and stop at the first handler that returns a non-null result.

---

## The Problem

Before this refactor, every mission constraint was a field on a plain object:

```js
const missionState = {
    stackSize: null,
    preferredDeliveryTiles: null,
    blacklistedDeliveryTiles: new Set(),
    rewardCap: null,
    forbiddenTiles: new Set(),
};
```

Adding a new constraint meant touching **6+ separate locations** across the codebase:
the state object, `hasMission()`, `resetMission()`, `getMissionState()`, `evaluateMission()`,
and every action function that needed to enforce the constraint.

## The Solution

Each constraint is a self-contained class. It owns its state and knows how to:
- report whether it is active
- reset itself
- serialize its state to JSON
- block or allow a pickup, a putdown, or a navigation step
- filter the parcel list
- annotate delivery tiles
- compute its expected value (EV)

`MissionConstraints` is the **registry**. It holds one instance of each constraint and
delegates every operation to all of them. The rest of the code only talks to
`MissionConstraints` — it does not know which constraints exist.

---

## File Structure

```
constraints/
├── Constraint.js                 ← base class (all methods are no-ops)
├── StackConstraint.js            ← min/max parcel stack
├── PreferredDeliveryConstraint.js← deliver only at specific tiles
├── BlacklistConstraint.js        ← never deliver at specific tiles
├── RewardCapConstraint.js        ← skip parcels above a reward threshold
├── ForbiddenTileConstraint.js    ← avoid specific tiles in pathfinding
├── MissionConstraints.js         ← registry and orchestrator
└── CONSTRAINTS.md                ← this file
```

---

## How a Constraint Class Works

Every constraint extends `Constraint` and overrides only the hooks it needs.
The base class provides no-op defaults for everything.

```js
import { Constraint } from './Constraint.js';

export class MyConstraint extends Constraint {
    constructor() {
        super();
        this.value = null; // your internal state
    }

    // Is this constraint currently doing anything?
    isActive() { return this.value !== null; }

    // Clear state back to inactive default.
    reset() { this.value = null; }

    // What to include in getMissionState() output.
    toJSON() { return { myValue: this.value }; }

    // Return an error string to block pickup, or null to allow it.
    checkPickup(carried, ctx) { return null; }

    // Return an error string to block putdown, or null to allow it.
    checkPutdown(tileKey, carried, ctx) { return null; }

    // Return true to exclude a tile from BFS navigation.
    isForbidden(tileKey) { return false; }

    // Return false to hide a parcel from getParcels().
    allowParcel(parcel) { return true; }

    // Add extra fields to a delivery tile object (e.g. blacklisted, preferred).
    decorateDeliveryTile(tile) { return tile; }

    // Compute expected value. Return null if your constraint does not handle this type.
    computeEV(params, stats) {
        if (params.type !== 'my_type') return null;
        // ... math here ...
        return { ev, guadagnoMissione, guadagnoStandard };
    }
}
```

You only need to override the methods that matter for your constraint.
Everything else stays as the no-op default.

---

## How MissionConstraints Delegates

`MissionConstraints` stores one instance of each constraint in `this._all`.
Every operation iterates over `this._all` and delegates:

| Operation | How it works |
|---|---|
| `hasMission()` | true if **any** constraint `.isActive()` |
| `reset()` | calls `.reset()` on **every** constraint |
| `toJSON()` | merges `.toJSON()` output from **every** constraint |
| `checkPickup(...)` | first non-null error from **any** constraint wins |
| `checkPutdown(...)` | first non-null error from **any** constraint wins |
| `isForbidden(key)` | true if **any** constraint forbids the tile |
| `filterParcels(parcels)` | keeps only parcels that **every** constraint allows |
| `decorateDeliveryTile(tile)` | chains through **every** constraint in order |
| `computeEV(params, stats)` | first non-null result from **any** constraint wins |

---

## How to Add a New Constraint

### Step 1 — Create the class

Create `src/bdi/llm/constraints/MyConstraint.js`:

```js
import { Constraint } from './Constraint.js';

export class MyConstraint extends Constraint {
    constructor() {
        super();
        this.myValue = null;
    }

    set(value) { this.myValue = value; }
    isActive()  { return this.myValue !== null; }
    reset()     { this.myValue = null; }
    toJSON()    { return { myValue: this.myValue }; }

    // Override only the hooks you need:
    checkPutdown(tileKey, carried, ctx) {
        if (this.myValue !== null && /* some condition */) {
            return `Mission constraint: reason here.`;
        }
        return null;
    }

    computeEV(params, stats) {
        if (params.type !== 'my_type') return null;
        const guadagnoMissione = /* ... */;
        const guadagnoStandard = /* ... */;
        return { ev: guadagnoMissione - guadagnoStandard, guadagnoMissione, guadagnoStandard };
    }
}
```

### Step 2 — Register it in MissionConstraints

Open `MissionConstraints.js` and add two lines:

```js
import { MyConstraint } from './MyConstraint.js';   // ← add import

export class MissionConstraints {
    constructor() {
        this.stack     = new StackConstraint();
        this.preferred = new PreferredDeliveryConstraint();
        this.blacklist = new BlacklistConstraint();
        this.rewardCap = new RewardCapConstraint();
        this.forbidden = new ForbiddenTileConstraint();
        this.my        = new MyConstraint();          // ← add instance
        this._all = [this.stack, this.preferred, this.blacklist,
                     this.rewardCap, this.forbidden, this.my]; // ← add to list
    }
    // ... nothing else changes
}
```

### Step 3 — Add a setter tool in llm_agent.js

```js
function setMyConstraint(input) {
    const value = parseFloat(input);
    if (isNaN(value)) return 'Error: expected a number.';
    mission.my.set(value);
    return `My constraint set to ${value}.`;
}
```

Register it in `TOOLS`:
```js
const TOOLS = {
    // ...
    set_my_constraint: setMyConstraint,
};
```

And add it in `mission_interpreter.js` as well (same pattern, using `beliefs.missionConstraints.my.set(value)`).

### Step 4 — Add EV type to the LLM system prompt (optional)

If the LLM needs to evaluate this constraint type, add it to `evaluate_mission` in the system prompts of `llm_agent.js` and `mission_interpreter.js`.

---

## What You Do NOT Need to Change

When adding a new constraint, **none of these files need to change**:

- `hasMission()` — auto-detects via `isActive()`
- `reset()` / `resetMission()` — auto-clears via `reset()`
- `getMissionState()` — auto-serializes via `toJSON()`
- `evaluateMission()` — auto-dispatches via `computeEV()`
- `pickUp()` — auto-gates via `checkPickup()`
- `putDown()` — auto-gates via `checkPutdown()`
- `bfsPath()` / `navigateTo()` — auto-routes via `isForbidden()`
- `getParcels()` — auto-filters via `filterParcels()`
- `getDeliveryTiles()` — auto-annotates via `decorateDeliveryTile()`
