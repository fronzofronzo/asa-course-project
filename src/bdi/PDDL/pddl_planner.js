import { onlineSolver } from "@unitn-asa/pddl-client";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Domain loaded once and cached.
let DOMAIN = null;
function getDomain() {
    if (DOMAIN === null) DOMAIN = readFileSync(path.join(__dirname, 'domain.pddl'), 'utf8');
    return DOMAIN;
}

const cellName = (x, y) => `c_${x}_${y}`;

const DIRS = [
    { dir: 'Up',    dx: 0,  dy: 1  },
    { dir: 'Down',  dx: 0,  dy: -1 },
    { dir: 'Left',  dx: -1, dy: 0  },
    { dir: 'Right', dx: 1,  dy: 0  },
];

const DIR_DELTA = Object.fromEntries(DIRS.map(d => [d.dir.toLowerCase(), { dx: d.dx, dy: d.dy }]));

/**
 * Canonical cell stepping for a direction (right=x+1, left=x-1, up=y+1, down=y-1).
 * Returns the cell the agent enters (`enter`) and the cell one further in the same
 * direction (`beyond`) — i.e. where a pushed crate would slide to.
 * @param {{x:number,y:number}} from
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {{enter:{x:number,y:number}, beyond:{x:number,y:number}}|null}
 */
export function stepCells(from, dir) {
    const d = DIR_DELTA[dir];
    if (!d) return null;
    const ex = Math.round(from.x) + d.dx, ey = Math.round(from.y) + d.dy;
    return { enter: { x: ex, y: ey }, beyond: { x: ex + d.dx, y: ey + d.dy } };
}

/**
 * Build a PDDL problem string from the current beliefs.
 * Cells = walkable tiles (c_x_y). Neighbour facts only between walkable cells
 * (walls are simply absent). Crates and agent position from beliefs.
 * @param {import('../belief.js').BeliefSet} beliefs
 * @param {{x:number,y:number}} from  agent start (rounded)
 * @param {{x:number,y:number}} to    goal cell
 * @param {Set<string>} excludedSpawns  "x,y" cells barred as crate slide targets (would self-block the path)
 * @returns {string}
 */
export function buildProblem(beliefs, from, to, excludedSpawns = new Set()) {
    const walkable = beliefs.map.walkable;
    const exitDirs = beliefs.map.exitDirs;
    const pushTargets = beliefs.map.pushTargets ?? new Set();
    const crateCells = beliefs.crateCells();

    const objects = [];
    const init = [];

    for (const key of walkable) {
        const [x, y] = key.split(',').map(Number);
        objects.push(cellName(x, y));

        const allowed = exitDirs.get(key); // undefined = all directions allowed
        for (const { dir, dx, dy } of DIRS) {
            if (allowed && !allowed.has(dir.toLowerCase())) continue;
            const nkey = `${x + dx},${y + dy}`;
            if (!walkable.has(nkey)) continue;
            init.push(`(neighbour${dir} ${cellName(x, y)} ${cellName(x + dx, y + dy)})`);
        }
    }

    // Crates may only be pushed onto yellow crate cells. Cells that would self-block
    // the agent's route to the goal are excluded, forcing the planner to push aside.
    for (const key of pushTargets) {
        if (excludedSpawns.has(key)) continue;
        const [x, y] = key.split(',').map(Number);
        init.push(`(crate-spawn ${cellName(x, y)})`);
    }

    for (const key of crateCells) {
        const [x, y] = key.split(',').map(Number);
        init.push(`(crate ${cellName(x, y)})`);
    }

    const fx = Math.round(from.x), fy = Math.round(from.y);
    init.push(`(at ${cellName(fx, fy)})`);

    const goal = `(at ${cellName(to.x, to.y)})`;

    return [
        '(define (problem deliveroo-crates-prob)',
        '    (:domain deliveroo-crates)',
        `    (:objects ${objects.join(' ')})`,
        `    (:init ${init.join(' ')})`,
        `    (:goal ${goal}))`,
    ].join('\n');
}

/**
 * Plan a path that may push crates out of the way.
 * @returns {Promise<Array<{action:string,args:string[]}>|null>} plan steps or null
 */
export async function planCrateMove(beliefs, from, to, excludedSpawns = new Set()) {
    const problem = buildProblem(beliefs, from, to, excludedSpawns);
    try {
        const plan = await onlineSolver(getDomain(), problem);
        if (!plan || plan.length === 0) return null;
        return plan;
    } catch (e) {
        console.warn(`[PDDL] solver error: ${e.message}`);
        return null;
    }
}

/**
 * Map a PDDL action (move-* or push-*) to a Deliveroo move direction.
 * Both move and push are executed live as a single emitMove: walking into a
 * crate cell makes the server slide the crate (Sokoban tiles).
 * @param {{action:string}} step
 * @returns {'up'|'down'|'left'|'right'|null}
 */
export function actionToDirection(step) {
    if (!step || !step.action) return null;
    const a = String(step.action).toLowerCase();
    if (a.endsWith('up')) return 'up';
    if (a.endsWith('down')) return 'down';
    if (a.endsWith('left')) return 'left';
    if (a.endsWith('right')) return 'right';
    return null;
}

