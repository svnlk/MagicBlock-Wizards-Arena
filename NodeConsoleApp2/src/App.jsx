import React, { Suspense, useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
    OrbitControls,
    Text,
    Cylinder,
    Billboard,
    useGLTF,
    Environment,
    Stars,
    Float,
    useAnimations
} from '@react-three/drei';
import * as THREE from 'three';
import { useGameStore } from './store';

const WIZARD_MODELS = {
    Pyro: '/models/pyro.glb',
    Cryo: '/models/cryo.glb',
    Arcane: '/models/arcane.glb',
    Dark: '/models/dark.glb'
};
const CORE_MODEL = '/models/core.glb';
const LANDSCAPE_MODEL = '/models/landscape.glb';

// --- КОНТРОЛЛЕР КАМЕРЫ (Разворот на 180 градусов) ---
function CameraHandler({ isEnemySide }) {
    const { camera } = useThree();

    useEffect(() => {
        // Если мы за Enemy — смотрим с положительной Z (8), если за Player — с отрицательной (-8)
        const zPos = isEnemySide ? 8 : -8;
        camera.position.set(0, 10, zPos);
        camera.lookAt(0, 0, 0);
    }, [isEnemySide, camera]);

    return null;
}

// --- МОДЕЛЬ ЛАНДШАФТА ---
function Landscape() {
    const { scene } = useGLTF(LANDSCAPE_MODEL);

    useEffect(() => {
        scene.traverse((child) => {
            if (child.isMesh) {
                child.receiveShadow = true;
                child.castShadow = true;
                if (child.material) {
                    child.material.roughness = 0.8;
                }
            }
        });
    }, [scene]);

    return <primitive object={scene} position={[0.1, -2.1, -0.43]} scale={0.9} />;
}

// --- ФОН ---
function Background() {
    return (
        <group>
            <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
            <fog attach="fog" args={['#050505', 10, 30]} />
            <Float speed={2} rotationIntensity={1} floatIntensity={2}>
                <mesh position={[-15, 5, -15]}>
                    <octahedronGeometry args={[2, 0]} />
                    <meshStandardMaterial color="#333" wireframe />
                </mesh>
            </Float>
        </group>
    );
}

// --- ЭФФЕКТЫ МАГИИ ---
function AbilityVFX({ effect, onComplete }) {
    const ref = useRef();
    const startTime = useRef(Date.now());

    useFrame(() => {
        if (!ref.current) return;
        const progress = Math.min((Date.now() - startTime.current) / effect.duration, 1);

        // Когда эффект завершился
        if (progress >= 1) {
            // Cryo: снять заморозку с юнита
            if (effect.type === 'Cryo' && effect.targetId) {
                const unit = useGameStore.getState().units.find(u => u.id === effect.targetId);
                if (unit) unit.isStunned = 0;
            }
            // Вызываем колбэк для удаления VFX
            onComplete(effect.id);
            return;
        }

        // Анимации по типу эффекта
        if (effect.type === 'Pyro') {
            ref.current.scale.setScalar(progress * 3);
            ref.current.material.opacity = 1 - progress;
        } else if (effect.type === 'Cryo') {
            ref.current.scale.setScalar(1 + progress * 0.5);
            ref.current.material.opacity = Math.sin(progress * Math.PI);
        } else if (effect.type === 'Arcane') {
            ref.current.scale.setScalar(0.5 + progress * 1.5);
            ref.current.material.opacity = 0.7 * (1 - progress);
        }
    });

    const [x, z] = effect.pos;

    if (effect.type === 'Pyro') {
        return (
            <mesh ref={ref} position={[x - 4, 0.2, z - 4]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[0.1, 1, 32]} />
                <meshStandardMaterial color="#ff4400" transparent emissive="#ff4400" emissiveIntensity={2} />
            </mesh>
        );
    }

    if (effect.type === 'Cryo') {
        return (
            <Cylinder ref={ref} args={[0.8, 0.8, 2, 16]} position={[x - 4, 1, z - 4]}>
                <meshStandardMaterial color="#00e5ff" transparent opacity={0.5} wireframe />
            </Cylinder>
        );
    }

    return null;
}

// --- МОДЕЛЬ ЯДРА ---
function CoreModel({ team }) {
    const group = useRef();
    const { scene, animations } = useGLTF(CORE_MODEL);
    const clonedScene = useMemo(() => {
        const clone = scene.clone();
        clone.traverse((child) => {
            if (child.isMesh) {
                child.material = child.material.clone();
                child.material.emissive = new THREE.Color(team === 'player' ? '#00ffcc' : '#ff0066');
                child.material.emissiveIntensity = 0.5;
            }
        });
        return clone;
    }, [scene, team]);

    const { actions } = useAnimations(animations, group);
    useEffect(() => {
        if (animations.length > 0 && actions[animations[0].name]) {
            actions[animations[0].name].reset().fadeIn(0.5).play();
        }
    }, [actions, animations]);

    return <primitive ref={group} object={clonedScene} scale={2} position={[0, 0.1, 0]} rotation={[0, Math.PI / 2, 0]} />;
}

// --- МОДЕЛЬ МАГА ---
function WizardModel({ type, isStunned }) {
    const { scene } = useGLTF(WIZARD_MODELS[type]);
    const clonedScene = useMemo(() => {
        const clone = scene.clone();
        clone.traverse((child) => {
            if (child.isMesh && isStunned > 0) {
                child.material = child.material.clone();
                child.material.emissive.set('#00e5ff');
                child.material.transparent = true;
                child.material.opacity = 0.6;
            }
        });
        return clone;
    }, [scene, isStunned]);

    return <primitive object={clonedScene} scale={0.25} position={[0, 0.25, 0]} rotation={[0, -Math.PI, 0]} />;
}

// --- КОМПОНЕНТ ЮНИТА ---
function Unit({ unit, selectedUnitId, selectUnit, handleAction }) {
    const group = useRef();
    const turnCount = useGameStore(s => s.turnCount);
    const { isAbilityMode, units } = useGameStore();

    const targetPos = useMemo(() => {
        const x = unit.pos[0] - 4;
        let z = unit.pos[1] - 4;
        if (unit.team !== 'player') z -= 0.05;
        return new THREE.Vector3(x, 0, z);
    }, [unit.pos, unit.team]);

    const targetRotationY = unit.type === 'Core' ? 0 : (unit.team === 'player' ? (Math.PI - Math.PI / 4) : (0 - Math.PI / 4));

    useFrame(() => {
        if (group.current) {
            group.current.position.lerp(targetPos, 0.05);
            group.current.rotation.y = targetRotationY;
        }
    });

    const isSelected = selectedUnitId === unit.id;
    const cd = 3 - (turnCount - unit.lastUsedTurn);
    const statusColor = unit.isStunned > 0 ? '#00e5ff' : (unit.team === 'player' ? '#0f4' : '#f04');

    const canBeAttacked = () => {
        const selectedUnit = units.find(u => u.id === selectedUnitId);
        if (!selectedUnit) return false;
        if (selectedUnit.team === unit.team) return false; // нельзя атаковать союзника
        const dx = Math.abs(selectedUnit.pos[0] - unit.pos[0]);
        const dz = Math.abs(selectedUnit.pos[1] - unit.pos[1]);
        return dx <= 1 && dz <= 1 && (dx !== 0 || dz !== 0); // соседняя клетка
    };

    return (
        <group
            ref={group}
            onClick={(e) => {
                e.stopPropagation();

                if (isAbilityMode) {
                    // Клик по юниту в режиме способности
                    handleAction(unit.pos, unit.id);
                } else if (canBeAttacked()) {
                    // Клик по соседнему врагу в обычном режиме — атака
                    handleAction(unit.pos, unit.id);
                } else {
                    // Просто выбор юнита
                    selectUnit(unit.id);
                }
            }}
        >
            <Cylinder args={[0.45, 0.45, 0.05, 32]} position={[0, 0.02, 0]}>
                <meshStandardMaterial color={statusColor} emissive={statusColor} emissiveIntensity={isSelected ? 2 : 0.5} />
            </Cylinder>
            {unit.type === 'Core' ? <CoreModel team={unit.team} /> : <WizardModel type={unit.type} isStunned={unit.isStunned} />}
            <Billboard position={[0, 2.2, 0]}>
                <Text fontSize={0.22} color="white" outlineWidth={0.03} outlineColor="black" textAlign="center">
                    {`${unit.type}${unit.type !== 'Core' && cd > 0 ? ` (${cd}т)` : ''}${unit.isStunned > 0 ? `\n[FROZEN]` : ''}\nHP: ${unit.hp}`}
                </Text>
            </Billboard>
        </group>
    );
}

// --- СЦЕНА ---
function Scene() {
    const { units, obstacles, selectedUnitId, isAbilityMode, handleAction, selectUnit, activeVFX, removeVFX } = useGameStore();
    const selectedUnit = units.find(u => u.id === selectedUnitId);

    const getHighlightColor = (x, z) => {
        if (!selectedUnit) return null;
        const { isOnline, clientTeam, currentTurn } = useGameStore.getState();
        if (selectedUnit.isStunned > 0 || selectedUnit.type === 'Core') return null;
        if (isOnline) {
            if (selectedUnit.team !== clientTeam) return null;
            if (clientTeam !== currentTurn) return null;
        } else {
            if (selectedUnit.team !== 'player') return null;
        }
        if (obstacles.some(o => o[0] === x && o[1] === z)) return null;
        const dx = Math.abs(selectedUnit.pos[0] - x);
        const dz = Math.abs(selectedUnit.pos[1] - z);
        if (isAbilityMode) {
            let r = (selectedUnit.type === 'Arcane' || selectedUnit.type === 'Cryo') ? 3 : (selectedUnit.type === 'Dark' ? 2 : 1);
            return dx <= r && dz <= r ? '#ffcc00' : null;
        }
        return dx <= 1 && dz <= 1 && (dx !== 0 || dz !== 0) ? '#00ff44' : null;
    };

    return (
        <>
            <Background />
            <Landscape />
            {Array.from({ length: 81 }).map((_, i) => {
                const x = i % 9, z = Math.floor(i / 9);
                const h = getHighlightColor(x, z);
                return (
                    <mesh key={i} position={[x - 4, 0.02, z - 4]} rotation={[-Math.PI / 2, 0, 0]} onClick={() => handleAction([x, z])}>
                        <planeGeometry args={[0.95, 0.95]} />
                        <meshStandardMaterial color={h || "white"} transparent opacity={h ? 0.5 : 0} />
                    </mesh>
                );
            })}
            {obstacles.map((obs, i) => (
                <mesh key={`obs-${i}`} position={[obs[0] - 4, 0.5, obs[1] - 4]}>
                    <boxGeometry args={[0.8, 1, 0.8]} />
                    <meshStandardMaterial color="#222" metalness={0.5} roughness={0.2} transparent opacity={0.8} />
                </mesh>
            ))}
            {units.map((unit) => <Unit key={unit.id} unit={unit} selectedUnitId={selectedUnitId} selectUnit={selectUnit} handleAction={handleAction} />)}
            {activeVFX.map(vfx => <AbilityVFX key={vfx.id} effect={vfx} onComplete={removeVFX} />)}
        </>
    );
}

function MultiplayerControls() {
    const { connectToServer, disconnectFromServer, connectionStatus, isOnline, clientTeam, roomId, serverUrl } = useGameStore();
    const [serverInput, setServerInput] = React.useState(serverUrl || 'ws://localhost:3001');
    const [roomInput, setRoomInput] = React.useState(roomId || 'room1');

    return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={serverInput} onChange={e => setServerInput(e.target.value)} style={{ padding: '6px', borderRadius: 4 }} placeholder="ws://server:3001" />
            <input value={roomInput} onChange={e => setRoomInput(e.target.value)} style={{ padding: '6px', borderRadius: 4, width: 120 }} placeholder="room id" />
            {!isOnline ? (
                <button onClick={() => connectToServer(serverInput, roomInput)} style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>Connect</button>
            ) : (
                <button onClick={() => disconnectFromServer()} style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>Disconnect</button>
            )}
            <div style={{ color: 'white', paddingLeft: 8 }}>
                <div style={{ fontSize: 12 }}>{connectionStatus}</div>
                <div style={{ fontSize: 12 }}>{isOnline ? `You: ${clientTeam || '?'}` : ''}</div>
            </div>
        </div>
    );
}

// --- ГЛАВНОЕ ПРИЛОЖЕНИЕ ---
export default function App() {
    const {
        toggleAbilityMode,
        isAbilityMode,
        selectedUnitId,
        units,
        currentTurn,
        winner,
        turnCount,
        isOnline,
        clientTeam
    } = useGameStore();

    const u = units.find(u => u.id === selectedUnitId);
    const isMyTurn = isOnline ? (currentTurn === clientTeam) : (currentTurn === 'player');

    // Флаг того, что мы на стороне врага
    const isEnemySide = isOnline && clientTeam === 'enemy';

    return (
        <div style={{ width: '100vw', height: '100vh', background: '#000', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 30, width: '100%', textAlign: 'center', color: 'white', zIndex: 10, pointerEvents: 'none' }}>
                {winner ? (
                    <h1 style={{ color: winner === 'player' ? '#0f4' : '#f04' }}>ПОБЕДА: {winner.toUpperCase()}</h1>
                ) : (
                    <>
                        <h2 style={{ textShadow: '2px 2px 4px black' }}>ХОД {turnCount}: {isMyTurn ? 'ВАШ' : 'ОППОНЕНТА'}</h2>
                        <div style={{ height: '60px', marginTop: '10px', pointerEvents: 'auto', display: 'flex', justifyContent: 'center', gap: '12px', alignItems: 'center' }}>
                            {u && isMyTurn && u.type !== 'Core' && (
                                <button
                                    onClick={toggleAbilityMode}
                                    style={{
                                        padding: '12px 25px',
                                        background: isAbilityMode ? '#fc0' : 'black',
                                        color: isAbilityMode ? 'black' : 'white',
                                        border: '1px solid white',
                                        borderRadius: '5px',
                                        cursor: 'pointer',
                                        fontWeight: 'bold'
                                    }}
                                >
                                    {isAbilityMode ? 'ОТМЕНА' : `МАГИЯ: ${u.type}`}
                                </button>
                            )}
                            <MultiplayerControls />
                        </div>
                    </>
                )}
            </div>

            <Canvas shadows={{ type: THREE.PCFSoftShadowMap }} camera={{ position: [0, 10, -8], fov: 45 }}>
                <Suspense fallback={null}>
                    {/* Этот компонент будет вращать камеру при смене команды */}
                    <CameraHandler isEnemySide={isEnemySide} />

                    <color attach="background" args={['#050505']} />
                    <ambientLight intensity={0.5} />
                    <pointLight position={[5, 10, 5]} intensity={1.5} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={4096} shadow-bias={-0.0005} />
                    <Environment preset="night" />
                    <Scene />
                    <OrbitControls
                        key={isEnemySide ? 'enemy' : 'player'} // Пересоздаем контролы при смене стороны
                        target={[0, 0, 0]}
                        enablePan={false}
                        maxPolarAngle={Math.PI / 2.1}
                        minDistance={5}
                        maxDistance={15}
                    />
                </Suspense>
            </Canvas>
        </div>
    );
}

Object.values(WIZARD_MODELS).forEach(p => useGLTF.preload(p));
useGLTF.preload(CORE_MODEL);
useGLTF.preload(LANDSCAPE_MODEL);