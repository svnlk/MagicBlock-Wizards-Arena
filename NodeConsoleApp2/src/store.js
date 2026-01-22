// store.js
import { create } from 'zustand';

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

export const useGameStore = create((set, get) => {
    const pClass = shuffle(CLASSES).slice(0, 3);
    const eClass = shuffle(CLASSES).slice(0, 3);

    const initialUnits = [
        ...[3, 4, 5].map((x, i) => ({ id: `p_w_${i}`, type: pClass[i], team: 'player', hp: 2, pos: [x, 1], lastUsedTurn: -3, isStunned: 0 })),
        { id: 'p_core', type: 'Core', team: 'player', hp: 3, pos: [4, 0], lastUsedTurn: -3, isStunned: 0 },
        ...[3, 4, 5].map((x, i) => ({ id: `e_w_${i}`, type: eClass[i], team: 'enemy', hp: 2, pos: [x, 7], lastUsedTurn: -3, isStunned: 0 })),
        { id: 'e_core', type: 'Core', team: 'enemy', hp: 3, pos: [4, 8], lastUsedTurn: -3, isStunned: 0 }
    ];

    const initialState = {
        units: initialUnits,
        obstacles: generateObstacles(5, initialUnits),
        selectedUnitId: null,
        currentTurn: 'player',
        turnCount: 1,
        winner: null,
        isAbilityMode: false,
        activeVFX: []
    };

    return {
        // game state
        ...initialState,

        // network state
        isOnline: false,
        ws: null,
        roomId: null,
        clientTeam: null, // 'player' | 'enemy' when online
        connectionStatus: 'disconnected', // 'disconnected'|'connecting'|'connected'
        serverUrl: null,

        // VFX and helpers (same as before)
        addVFX: (type, pos, duration = 500) => {
            set((state) => ({ activeVFX: [...state.activeVFX, { id: Date.now() + Math.random(), type, pos, duration }] }));
        },

        removeVFX: (id) => {
            set((state) => ({ activeVFX: state.activeVFX.filter(vfx => vfx.id !== id) }));
        },

        // --- NETWORK: connect to WS server and join room
        connectToServer: (serverUrl, roomId) => {
            if (get().ws) get().disconnectFromServer();
            set({ connectionStatus: 'connecting', serverUrl, roomId });
            try {
                const ws = new WebSocket(serverUrl);
                set({ ws });

                ws.onopen = () => {
                    ws.send(JSON.stringify({ type: 'join', roomId }));
                };
                ws.onmessage = (raw) => {
                    try {
                        const msg = JSON.parse(raw.data);
                        if (msg.type === 'joined') {
                            // assignedTeam + initial state
                            const { assignedTeam, state } = msg;
                            set({
                                isOnline: true,
                                connectionStatus: 'connected',
                                clientTeam: assignedTeam,
                                ...state
                            });
                        } else if (msg.type === 'state') {
                            // full authoritative state update from server
                            set({
                                units: msg.state.units,
                                obstacles: msg.state.obstacles,
                                currentTurn: msg.state.currentTurn,
                                turnCount: msg.state.turnCount,
                                winner: msg.state.winner,
                                isAbilityMode: msg.state.isAbilityMode,
                                activeVFX: msg.state.activeVFX
                            });
                        } else if (msg.type === 'peer-joined') {
                            // ignore or show ephemeral UI
                        } else if (msg.type === 'peer-left') {
                            set({ connectionStatus: 'connected', isOnline: true }); // keep state — opponent left
                        } else if (msg.type === 'error') {
                            console.warn('Server error:', msg.message);
                        }
                    } catch (e) {
                        console.error('bad msg', e);
                    }
                };
                ws.onclose = () => {
                    set({ isOnline: false, ws: null, clientTeam: null, connectionStatus: 'disconnected' });
                };
                ws.onerror = (e) => {
                    console.error('ws error', e);
                    set({ connectionStatus: 'disconnected', isOnline: false });
                };
            } catch (e) {
                console.error('connect failed', e);
                set({ connectionStatus: 'disconnected', isOnline: false });
            }
        },

        disconnectFromServer: () => {
            const ws = get().ws;
            if (ws) {
                try { ws.close(); } catch (e) { }
            }
            set({ ws: null, isOnline: false, connectionStatus: 'disconnected', clientTeam: null, roomId: null });
        },

        // helper to send action messages to server
        sendActionToServer: (payload) => {
            const ws = get().ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) return false;
            ws.send(JSON.stringify({ type: 'action', payload }));
            return true;
        },

        // --- Gameplay functions (local or online-aware) ---
        selectUnit: (id) => {
            const { isOnline, clientTeam, currentTurn, units } = get();
            const unit = units.find(u => u.id === id);
            if (!unit) return;

            // онлайн: можно выбирать только своих и только в свой ход
            if (isOnline) {
                if (unit.team !== clientTeam) return;
                if (clientTeam !== currentTurn) return;
            } else {
                // оффлайн: только игрок и только в его ход
                if (unit.team !== 'player') return;
                if (currentTurn !== 'player') return;
            }

            set({ selectedUnitId: id, isAbilityMode: false });
        },


        toggleAbilityMode: () => {
            const { units, selectedUnitId, turnCount, isOnline, clientTeam, currentTurn } = get();
            const unit = units.find(u => u.id === selectedUnitId);
            if (!unit) return;
            // if online, ensure this client controls the team whose turn it is and unit belongs to them
            if (isOnline) {
                if (clientTeam !== currentTurn) return;
                if (unit.isStunned !== 0 || unit.type === 'Core') return;
                // cooldown check still local for UX (server will validate on action)
                // онлайн — НЕ проверяем cooldown (сервер авторитетный)
                if (isOnline) {
                    if (clientTeam !== currentTurn) return;
                    if (unit.isStunned !== 0 || unit.type === 'Core') return;

                    set(state => ({ isAbilityMode: !state.isAbilityMode }));
                    return;
                }

                set((state) => ({ isAbilityMode: !state.isAbilityMode }));
                return;
            }
            if (unit && unit.isStunned === 0 && unit.type !== 'Core' && turnCount - unit.lastUsedTurn >= 3) {
                set((state) => ({ isAbilityMode: !state.isAbilityMode }));
            }
        },

        handleAction: (targetPos) => {
            const {
                selectedUnitId,
                winner,
                isAbilityMode,
                isOnline,
                clientTeam,
                currentTurn,
                units
            } = get();

            if (!selectedUnitId || winner) return;

            const unit = units.find(u => u.id === selectedUnitId);
            if (!unit || unit.isStunned > 0) return;

            // онлайн: только в свой ход
            if (isOnline) {
                if (clientTeam !== currentTurn) return;

                get().sendActionToServer({
                    team: clientTeam,
                    selectedUnitId,
                    actionType: isAbilityMode ? 'ability' : 'move',
                    targetPos
                });
                return;
            }

            // оффлайн
            if (isAbilityMode) {
                if (get().executeAbility(unit, targetPos)) get().finalizeTurn();
            } else {
                get().executeMove(selectedUnitId, targetPos);
            }
        },


        // --- existing attack/move/ability logic (local offline fallback) ---
        executeAbility: (unit, targetPos) => {
            const { units, turnCount, obstacles, addVFX } = get();
            if (obstacles.some(o => o[0] === targetPos[0] && o[1] === targetPos[1])) return false;
            const dx = Math.abs(unit.pos[0] - targetPos[0]), dz = Math.abs(unit.pos[1] - targetPos[1]);
            let newUnits = [...units], success = false;

            if (unit.type === 'Pyro' && dx <= 1 && dz <= 1) {
                newUnits = units.map(u => (Math.abs(u.pos[0] - targetPos[0]) <= 1 && Math.abs(u.pos[1] - targetPos[1]) <= 1 && u.team !== unit.team) ? { ...u, hp: u.hp - 1 } : u).filter(u => u.hp > 0);
                addVFX('Pyro', targetPos, 700);
                success = true;
            } else if (unit.type === 'Cryo' && dx <= 3 && dz <= 3) {
                const target = units.find(u => u.pos[0] === targetPos[0] && u.pos[1] === targetPos[1] && u.team !== unit.team);
                if (target) { newUnits = units.map(u => u.id === target.id ? { ...u, isStunned: 2 } : u); addVFX('Cryo', target.pos, 1000); success = true; }
            } else if (unit.type === 'Arcane' && dx <= 3 && dz <= 3) {
                if (!units.some(u => u.pos[0] === targetPos[0] && u.pos[1] === targetPos[1])) {
                    addVFX('Arcane', unit.pos, 400);
                    newUnits = units.map(u => u.id === unit.id ? { ...u, pos: targetPos } : u);
                    setTimeout(() => addVFX('Arcane', targetPos, 400), 100);
                    success = true;
                }
            } else if (unit.type === 'Dark' && dx <= 2 && dz <= 2) {
                const target = units.find(u => u.pos[0] === targetPos[0] && u.pos[1] === targetPos[1] && u.team !== unit.team);
                if (target) {
                    newUnits = units.map(u => u.id === target.id ? { ...u, hp: u.hp - 1 } : u.id === unit.id ? { ...u, hp: Math.min(u.hp + 1, 2) } : u).filter(u => u.hp > 0);
                    addVFX('Dark', target.pos, 600);
                    success = true;
                }
            }
            if (success) set({ units: newUnits.map(u => u.id === unit.id ? { ...u, lastUsedTurn: turnCount } : u) });
            return success;
        },

        executeMove: (unitId, targetPos) => {
            const { units, obstacles, addVFX } = get();
            const unit = units.find(u => u.id === unitId);
            if (!unit || unit.isStunned > 0 || unit.type === 'Core' || obstacles.some(o => o[0] === targetPos[0] && o[1] === targetPos[1])) return false;
            const dx = Math.abs(unit.pos[0] - targetPos[0]), dz = Math.abs(unit.pos[1] - targetPos[1]);
            if (dx <= 1 && dz <= 1 && (dx !== 0 || dz !== 0)) {
                const target = units.find(u => u.pos[0] === targetPos[0] && u.pos[1] === targetPos[1]);
                if (target && target.team !== unit.team) {
                    set({ units: units.map(u => u.id === target.id ? { ...u, hp: u.hp - 1 } : u).filter(u => u.hp > 0) });
                    addVFX('Melee', target.pos, 300); get().finalizeTurn(); return true;
                } else if (!target) {
                    set({ units: units.map(u => u.id === unitId ? { ...u, pos: targetPos } : u) });
                    get().finalizeTurn(); return true;
                }
            }
            return false;
        },

        finalizeTurn: () => {
            const win = !get().units.some(u => u.id === 'e_core') ? 'player' : (!get().units.some(u => u.id === 'p_core') ? 'enemy' : null);
            set({ currentTurn: 'enemy', selectedUnitId: null, isAbilityMode: false, winner: win });
            if (!win && !get().isOnline) setTimeout(() => get().runBotTurn(), 1000);
        },

        // bot logic left as-is for offline singleplayer
        runBotTurn: () => {
            const { units, winner, turnCount, obstacles } = get();
            if (winner) return;

            let currentUnits = units.map(u => (u.team === 'enemy' && u.isStunned > 0) ? { ...u, isStunned: u.isStunned - 1 } : u);
            set({ units: currentUnits });

            const activeBots = currentUnits.filter(u => u.team === 'enemy' && u.type !== 'Core' && u.isStunned === 0);
            if (activeBots.length === 0) { get().finalizeBotTurn(); return; }

            const bot = shuffle(activeBots)[0];
            const playerUnits = currentUnits.filter(u => u.team === 'player');
            const enemyCore = currentUnits.find(u => u.id === 'e_core');

            let done = false;

            const dangerUnit = [...playerUnits].sort((a, b) => {
                const distA = Math.max(Math.abs(a.pos[0] - enemyCore.pos[0]), Math.abs(a.pos[1] - enemyCore.pos[1]));
                const distB = Math.max(Math.abs(b.pos[0] - enemyCore.pos[0]), Math.abs(b.pos[1] - enemyCore.pos[1]));
                return distA - distB;
            })[0];

            const distToCore = Math.max(Math.abs(dangerUnit.pos[0] - enemyCore.pos[0]), Math.abs(dangerUnit.pos[1] - enemyCore.pos[1]));
            const targetUnit = distToCore <= 3 ? dangerUnit : playerUnits.find(u => u.type === 'Core') || dangerUnit;

            if (turnCount - bot.lastUsedTurn >= 3) {
                const d = Math.max(Math.abs(targetUnit.pos[0] - bot.pos[0]), Math.abs(targetUnit.pos[1] - bot.pos[1]));
                let canCast = false;
                if ((bot.type === 'Cryo' || bot.type === 'Arcane') && d <= 3) canCast = true;
                else if (bot.type === 'Dark' && d <= 2) canCast = true;
                else if (bot.type === 'Pyro' && d <= 1) canCast = true;

                if (canCast) done = get().executeAbility(bot, targetUnit.pos);
            }

            if (!done) {
                const directions = [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1]];
                directions.sort((a, b) => {
                    const distA = Math.abs((bot.pos[0] + a[0]) - targetUnit.pos[0]) + Math.abs((bot.pos[1] + a[1]) - targetUnit.pos[1]);
                    const distB = Math.abs((bot.pos[0] + b[0]) - targetUnit.pos[0]) + Math.abs((bot.pos[1] + b[1]) - targetUnit.pos[1]);
                    return distA - distB;
                });

                for (const [dx, dz] of directions) {
                    const np = [bot.pos[0] + dx, bot.pos[1] + dz];
                    if (np[0] < 0 || np[0] > 8 || np[1] < 0 || np[1] > 8 || obstacles.some(o => o[0] === np[0] && o[1] === np[1])) continue;

                    const occupant = currentUnits.find(u => u.pos[0] === np[0] && u.pos[1] === np[1]);
                    if (occupant?.team === 'enemy') continue;

                    if (occupant?.team === 'player') {
                        set({ units: get().units.map(u => u.id === occupant.id ? { ...u, hp: u.hp - 1 } : u).filter(u => u.hp > 0) });
                        get().addVFX('Melee', occupant.pos, 300);
                        done = true; break;
                    } else if (!occupant) {
                        set({ units: get().units.map(u => u.id === bot.id ? { ...u, pos: np } : u) });
                        done = true; break;
                    }
                }
            }
            get().finalizeBotTurn();
        },

        finalizeBotTurn: () => {
            setTimeout(() => {
                const uNow = get().units;
                const w = !uNow.some(u => u.id === 'e_core') ? 'player' : (!uNow.some(u => u.id === 'p_core') ? 'enemy' : null);
                set(s => ({
                    currentTurn: 'player',
                    turnCount: s.turnCount + 1,
                    winner: w,
                    units: s.units.map(u => (u.team === 'player' && u.isStunned > 0) ? { ...u, isStunned: u.isStunned - 1 } : u)
                }));
            }, 600);
        }
    };
});
