// server.js
// Простой авторитетный WebSocket-сервер для 1v1 матчей.
// npm i ws
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 3001 }, () => {
    console.log('WS server listening on ws://localhost:3001');
});

const CLASSES = ['Pyro', 'Cryo', 'Arcane', 'Dark'];
const shuffle = (array) => {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
};
const generateObstacles = (count, units) => {
    const obs = [];
    while (obs.length < count) {
        const newObs = [Math.floor(Math.random() * 9), Math.floor(Math.random() * 5) + 2];
        const isOccupied = units.some(u => u.pos[0] === newObs[0] && u.pos[1] === newObs[1]) ||
            obs.some(o => o[0] === newObs[0] && o[1] === newObs[1]);
        if (!isOccupied) obs.push(newObs);
    }
    return obs;
};

const rooms = new Map(); // roomId -> {clients: [ws,..], state, createdAt}

function makeInitialState() {
    const pClass = shuffle(CLASSES).slice(0, 3);
    const eClass = shuffle(CLASSES).slice(0, 3);
    const initialUnits = [
        ...[3, 4, 5].map((x, i) => ({ id: `p_w_${i}`, type: pClass[i], team: 'player', hp: 2, pos: [x, 1], lastUsedTurn: -3, isStunned: 0 })),
        { id: 'p_core', type: 'Core', team: 'player', hp: 3, pos: [4, 0], lastUsedTurn: -3, isStunned: 0 },
        ...[3, 4, 5].map((x, i) => ({ id: `e_w_${i}`, type: eClass[i], team: 'enemy', hp: 2, pos: [x, 7], lastUsedTurn: -3, isStunned: 0 })),
        { id: 'e_core', type: 'Core', team: 'enemy', hp: 3, pos: [4, 8], lastUsedTurn: -3, isStunned: 0 }
    ];
    return {
        units: initialUnits,
        obstacles: generateObstacles(5, initialUnits),
        currentTurn: 'player',
        turnCount: 1,
        winner: null,
        isAbilityMode: false,
        activeVFX: []
    };
}

function broadcast(room, msg) {
    for (const c of room.clients) {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
    }
}

// CORE: execute ability / move on server-side (port of your logic, simplified)
function addVFX(state, type, pos, duration = 500) {
    state.activeVFX = [...state.activeVFX, { id: Date.now() + Math.random(), type, pos, duration }];
}
function executeAbilityOnState(state, unit, targetPos) {
    const { units, turnCount, obstacles } = state;
    if (obstacles.some(o => o[0] === targetPos[0] && o[1] === targetPos[1])) return false;
    const dx = Math.abs(unit.pos[0] - targetPos[0]), dz = Math.abs(unit.pos[1] - targetPos[1]);
    let newUnits = [...units], success = false;

    if (unit.type === 'Pyro' && dx <= 1 && dz <= 1) {
        newUnits = units.map(u => (Math.abs(u.pos[0] - targetPos[0]) <= 1 && Math.abs(u.pos[1] - targetPos[1]) <= 1 && u.team !== unit.team) ? { ...u, hp: u.hp - 1 } : u).filter(u => u.hp > 0);
        addVFX(state, 'Pyro', targetPos, 700);
        success = true;
    } else if (unit.type === 'Cryo' && dx <= 3 && dz <= 3) {
        const target = units.find(u => u.pos[0] === targetPos[0] && u.pos[1] === targetPos[1] && u.team !== unit.team);
        if (target) { newUnits = units.map(u => u.id === target.id ? { ...u, isStunned: 2 } : u); addVFX(state, 'Cryo', target.pos, 1000); success = true; }
    } else if (unit.type === 'Arcane' && dx <= 3 && dz <= 3) {
        if (!units.some(u => u.pos[0] === targetPos[0] && u.pos[1] === targetPos[1])) {
            addVFX(state, 'Arcane', unit.pos, 400);
            newUnits = units.map(u => u.id === unit.id ? { ...u, pos: targetPos } : u);
            setTimeout(() => { }, 100); // noop for server VFX timing
            success = true;
        }
    } else if (unit.type === 'Dark' && dx <= 2 && dz <= 2) {
        const target = units.find(u => u.pos[0] === targetPos[0] && u.pos[1] === targetPos[1] && u.team !== unit.team);
        if (target) {
            newUnits = units.map(u => u.id === target.id ? { ...u, hp: u.hp - 1 } : u.id === unit.id ? { ...u, hp: Math.min(u.hp + 1, 2) } : u).filter(u => u.hp > 0);
            addVFX(state, 'Dark', target.pos, 600);
            success = true;
        }
    }
    if (success) {
        state.units = newUnits.map(u =>
            u.id === unit.id
                ? { ...u, lastUsedTurn: state.turnCount }
                : u
        );
    }
    return success;
}
function executeMoveOnState(state, unitId, targetPos) {
    const { units, obstacles } = state;
    const unit = units.find(u => u.id === unitId);
    if (!unit || unit.isStunned > 0 || unit.type === 'Core' || obstacles.some(o => o[0] === targetPos[0] && o[1] === targetPos[1])) return false;
    const dx = Math.abs(unit.pos[0] - targetPos[0]), dz = Math.abs(unit.pos[1] - targetPos[1]);
    if (dx <= 1 && dz <= 1 && (dx !== 0 || dz !== 0)) {
        const target = units.find(u => u.pos[0] === targetPos[0] && u.pos[1] === targetPos[1]);
        if (target && target.team !== unit.team) {
            state.units = units.map(u => u.id === target.id ? { ...u, hp: u.hp - 1 } : u).filter(u => u.hp > 0);
            addVFX(state, 'Melee', targetPos, 300);
            finalizeTurnOnState(state);
            return true;
        } else if (!target) {
            state.units = units.map(u => u.id === unitId ? { ...u, pos: targetPos } : u);
            finalizeTurnOnState(state);
            return true;
        }
    }
    return false;
}
function finalizeTurnOnState(state) {
    const win = !state.units.some(u => u.id === 'e_core') ? 'player' : (!state.units.some(u => u.id === 'p_core') ? 'enemy' : null);
    state.currentTurn = (win ? state.currentTurn : (state.currentTurn === 'player' ? 'enemy' : 'player'));
    state.isAbilityMode = false;
    state.winner = win;
    if (!win) state.turnCount = state.turnCount + (state.currentTurn === 'player' ? 1 : 0); // keep turnCount semantics similar-ish
}

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'join') {
                const { roomId } = msg;
                if (!rooms.has(roomId)) {
                    rooms.set(roomId, { clients: [], state: makeInitialState(), createdAt: Date.now() });
                }
                const room = rooms.get(roomId);
                if (room.clients.length >= 2) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
                    return;
                }
                room.clients.push(ws);
                ws._roomId = roomId;
                ws._playerIndex = room.clients.length - 1; // 0 or 1
                ws.send(JSON.stringify({ type: 'joined', assignedTeam: ws._playerIndex === 0 ? 'player' : 'enemy', state: room.state }));
                // notify other player that someone joined
                broadcast(room, { type: 'peer-joined', count: room.clients.length });
                // if two players — broadcast start state
                if (room.clients.length === 2) {
                    broadcast(room, { type: 'state', state: room.state });
                }
            } else if (msg.type === 'action') {
                const roomId = ws._roomId;
                if (!roomId || !rooms.has(roomId)) { ws.send(JSON.stringify({ type: 'error', message: 'No room' })); return; }
                const room = rooms.get(roomId);
                const s = room.state;
                // apply incoming action only if it's the correct turn
                // msg.payload: { team, selectedUnitId, actionType: 'move'|'ability', targetPos: [x,z] }
                const p = msg.payload;
                if (s.winner) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Game finished' }));
                    return;
                }
                if (p.team !== s.currentTurn) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Not your turn' }));
                    return;
                }
                const unit = s.units.find(u => u.id === p.selectedUnitId && u.team === p.team);
                if (!unit) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid unit' })); return; }

                let applied = false;
                if (p.actionType === 'ability') {
                    applied = executeAbilityOnState(s, unit, p.targetPos);
                    if (applied) finalizeTurnOnState(s);
                } else if (p.actionType === 'move') {
                    applied = executeMoveOnState(s, p.selectedUnitId, p.targetPos);
                }
                // broadcast new state to both clients (even if nothing changed, send so clients stay synced)
                broadcast(room, { type: 'state', state: s });
            } else if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (e) {
            console.error('bad message', e);
        }
    });

    ws.on('close', () => {
        const roomId = ws._roomId;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.clients = room.clients.filter(c => c !== ws);
        if (room.clients.length === 0) rooms.delete(roomId);
        else broadcast(room, { type: 'peer-left' });
    });
});
