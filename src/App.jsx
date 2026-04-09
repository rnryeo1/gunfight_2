import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useRef, useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { createMpBridge } from './mpBridge.js'

let hitAudioCtx = null
function getHitAudioContext() {
  if (typeof window === 'undefined') return null
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  if (!hitAudioCtx) hitAudioCtx = new Ctx()
  return hitAudioCtx
}

function playPlayerHitFeedbackSound(sniper) {
  const ctx = getHitAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  const t0 = ctx.currentTime
  const dur = sniper ? 0.22 : 0.16
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(sniper ? 120 : 165, t0)
  osc.frequency.exponentialRampToValueAtTime(48, t0 + dur * 0.85)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(sniper ? 0.11 : 0.075, t0 + 0.014)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(g)
  g.connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)

  const noiseDur = sniper ? 0.045 : 0.032
  const nBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * noiseDur), ctx.sampleRate)
  const ch = nBuf.getChannelData(0)
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length)
  const ns = ctx.createBufferSource()
  ns.buffer = nBuf
  const nf = ctx.createBiquadFilter()
  nf.type = 'bandpass'
  nf.frequency.value = sniper ? 520 : 680
  nf.Q.value = 0.85
  const ng = ctx.createGain()
  ng.gain.setValueAtTime(0.0001, t0)
  ng.gain.linearRampToValueAtTime(sniper ? 0.07 : 0.045, t0 + 0.004)
  ng.gain.exponentialRampToValueAtTime(0.0001, t0 + noiseDur)
  ns.connect(nf)
  nf.connect(ng)
  ng.connect(ctx.destination)
  ns.start(t0)
  ns.stop(t0 + noiseDur + 0.01)
}

function bumpPlayerHitFx(fxRef, sniper) {
  const fx = fxRef?.current
  if (!fx) return
  fx.vignette = Math.min(1, Math.max(fx.vignette, sniper ? 0.82 : 0.52))
  fx.shake = Math.max(fx.shake, sniper ? 0.42 : 0.26)
  fx.flash = Math.min(1, Math.max(fx.flash, sniper ? 0.58 : 0.4))
  playPlayerHitFeedbackSound(sniper)
}

function HitFeedbackOverlay({ fxRef }) {
  const [v, setV] = useState(0)
  const [fl, setFl] = useState(0)
  useEffect(() => {
    let id = 0
    const loop = () => {
      const fx = fxRef.current
      setV(fx?.vignette ?? 0)
      setFl(fx?.flash ?? 0)
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [fxRef])
  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 6,
          background: `radial-gradient(ellipse 92% 80% at 50% 42%, transparent 0%, transparent 22%, rgba(200, 12, 40, ${v * 0.68}) 100%)`,
        }}
      />
      <div
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 7,
          background: `rgba(255, 245, 235, ${fl * 0.38})`,
          mixBlendMode: 'screen',
        }}
      />
    </>
  )
}

const CAM_OFFSET = new THREE.Vector3(14, 16, 14)
const CAM_ZOOM_MIN = 0.5
const CAM_ZOOM_MAX = 1.72
const CAM_ZOOM_PER_NOTCH = 1.06
/** 우클릭 드래그 시 카메라 수평 회전 (라디안/픽셀, 마우스 오른쪽으로 당기면 시계 방향 궤도) */
const CAM_ORBIT_YAW_PER_PX = 0.0021
/** 우클릭 드래그 시 카메라 수직 회전 (라디안/픽셀, 마우스를 아래로 당기면 아래를 더 내려다봄) */
const CAM_ORBIT_PITCH_PER_PX = 0.0021
/** 추가 피치 상한·하한 (라디안, 기본 오프셋 기준) */
const CAM_ORBIT_PITCH_MIN = -1.25
const CAM_ORBIT_PITCH_MAX = 0.92
/** 충돌 반경(가늘게) · 시각는 원통 탄환 */
const BULLET_HIT_RADIUS = 0.056
const BULLET_VIS_RADIUS = 0.02
const BULLET_VIS_LENGTH = 0.82
const BULLET_RADIUS = BULLET_HIT_RADIUS
const ENEMY_HALF = { x: 0.5, y: 0.75, z: 0.5 }
const ENEMY_COUNT = 42
/** 오픈월드 MMO: 맵 대비 적 밀도 (솔로보다 많게) */
const MMO_ENEMY_COUNT = 96
/** 가로(X) · 세로(Z) — Fly Pieter 느낌의 넓은 오픈 필드 */
const MAP_HALF_X = 300
const MAP_HALF_Z = 420
const MAP_HALF = Math.max(MAP_HALF_X, MAP_HALF_Z)
const TERRAIN_PAD = 36
const TERRAIN_W = MAP_HALF_X * 2 + TERRAIN_PAD
const TERRAIN_D = MAP_HALF_Z * 2 + TERRAIN_PAD
const TERRAIN_SEG_X = 176
const TERRAIN_SEG_Z = 244
const SIGHT_RADIUS = 128
/** 거리 비네트 완화 — 멀리·그림자 느낌 영역이 덜 짙게 */
const VISION_VIG_POWER = 0.32
/** 언덕·높이 차에 덜 끊기도록 완화 */
const VISION_HEIGHT_SLACK = 0.34
const VISION_MIN_FACTOR = 0.006
/** 목표가 눈높이 이하일 때 시야선 가림 판정 완화 (낮은 언덕·골 더 잘 보임) */
const VISION_LOOKDOWN_RELAX_Y = 0.28
const VISION_LOOKDOWN_LOS_EPS = 0.36
const PLAYER_EYE_LIFT = 1.42
const LOS_STEPS = 49
const LOS_CLEAR_EPS = 0.095
const WALL_THICK = 2.2
const WALL_HEIGHT = 5.5
const PLAYER_R = 0.34
const PILLAR_COUNT = 110
const PILLAR_RADIUS = 0.58
const PILLAR_HEIGHT = 4.1
const PILLAR_CENTER_Y = PILLAR_HEIGHT / 2
const ENEMY_RADIUS_XZ = 0.68
const ENEMY_MAX_HP = 100
const AGRO_RANGE = 24
const CHASE_SPEED = 2.65
const STOP_DISTANCE = 0.92
const BAR_WIDTH = 0.95
const BAR_H = 0.11

/** 로컬 2인 CTF */
const GAME_MODE_SOLO = 'solo'
const GAME_MODE_CTF = 'ctf_local'
const GAME_MODE_CTF_ONLINE = 'ctf_online'
/** 브라우저별 1인 · 넓은 맵 · 다수 동시 접속(릴레이) · PvE 중심 */
const GAME_MODE_MMO_ONLINE = 'mmo_online'
/** 온라인 깃발: 포즈·CTF 상태 동기화 주기 */
const MP_CTF_TICK_SEC = 0.09
/** MMO 릴레이: 간격을 넓혀 CPU·네트워크 부담 감소 (원격 캡슐은 살짝 덜 부드러울 수 있음) */
const MP_MMO_POSE_TICK_SEC = 0.22

function isCtfGameMode(mode) {
  return mode === GAME_MODE_CTF || mode === GAME_MODE_CTF_ONLINE
}

/** 로컬: 같은 호스트 :8787. 프로덕션은 `VITE_MP_WS` 또는 `/mp-ws-config.json` 권장 */
function inferMpWsUrl() {
  if (import.meta.env.VITE_MP_WS) return String(import.meta.env.VITE_MP_WS)
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const h = window.location.hostname
    const secure = window.location.protocol === 'https:'
    return `${secure ? 'wss' : 'ws'}://${h}:8787`
  }
  return 'ws://127.0.0.1:8787'
}

function mpWsConfigFetchUrl() {
  const b = import.meta.env.BASE_URL || '/'
  const prefix = b.endsWith('/') ? b : `${b}/`
  return `${prefix}mp-ws-config.json`
}

/** https로 배포됐는데 아직 :8787(로컬 기본)이면 릴레이 주소를 따로 넣어야 함 */
function showHostedRelayUrlWarning(wsUrl) {
  if (typeof window === 'undefined') return false
  if (window.location.protocol !== 'https:') return false
  const h = window.location.hostname
  if (h === 'localhost' || h === '127.0.0.1') return false
  return /:8787\b/.test(wsUrl)
}
/** 팀0(파랑) 서쪽(X-) 아군 · 팀1(주황) 동쪽(X+) 적 (맵 90° 회전 배치) */
const CTF_BASE_CENTER_X = [
  Math.round(-MAP_HALF_X * 0.72),
  Math.round(MAP_HALF_X * 0.72),
]
const CTF_BASE_RADIUS = 8.5
const CTF_FLAG_GRAB_R = 2.85
/** 기지 중심에서 막대를 옆으로 살짝 (Z축) */
const CTF_FLAG_POLE_Z = [3.2, -3.2]
/** 깃발 운반 시 이동 속도 배율 (20% 감소 = 80%) */
const FLAG_CARRY_SPEED_MULT = 0.8
const PLAYER_MAX_HP = 100
/** 솔로·MMO 생존: 초당 HP 감소 (100 기준 1/초) */
const WORLD_HP_DRAIN_PER_SEC = 1
const WORLD_HP_PICKUP_HEAL = 25
const WORLD_HP_PICKUP_RADIUS = 1.38
const WORLD_HP_PICKUP_COUNT = 36
const WORLD_HP_PICKUP_RESPAWN_SEC_MIN = 2.5
const WORLD_HP_PICKUP_RESPAWN_SEC_MAX = 5.8
/** 솔로: 보급 상자 · 몽둥이 · 공용 탄약 */
const WORLD_LOOT_CRATE_COUNT = 12
/** MMO: 같은 맵에 유저가 많을 때 보급 상자 추가 */
const WORLD_LOOT_CRATE_COUNT_MMO = 22
const CRATE_HALF = { x: 0.52, y: 0.55, z: 0.52 }
/** 적 처치 시 생존 HP 회복 (솔로/MMO) */
const ENEMY_KILL_HEAL = 20
const MG_START_AMMO = 30
const SNIPER_START_AMMO = 10
const AMMO_PICKUP_RADIUS = 1.34
const AMMO_DROP_ENEMY_AMOUNT = 24
const CLUB_MELEE_RANGE = 3.93
const CLUB_MELEE_COS = Math.cos((50 * Math.PI) / 180)
const CLUB_MELEE_DAMAGE = 15
/** 몽둥이 스윙: 3구간(긴장-휘두르기-여운) · 타격은 2구간 초반 (공속 2배) */
const CLUB_SWING_DURATION = 0.38
const CLUB_SWING_PHASE1 = 0.34
const CLUB_SWING_PHASE2_END = 0.62
const CLUB_HIT_T0 = 0.14

function createClubSwingState() {
  return {
    active: false,
    elapsed: 0,
    fx: 0,
    fz: 1,
    px: 0,
    pz: 0,
    hitApplied: false,
  }
}

function applyClubSwingVisual(groupRef, elapsed) {
  const g = groupRef?.current
  if (!g) return
  const u = Math.min(1, elapsed / CLUB_SWING_DURATION)
  if (u >= 1) {
    g.rotation.set(0, 0, 0)
    return
  }
  const p1 = CLUB_SWING_PHASE1
  const p2 = CLUB_SWING_PHASE2_END
  let rx = 0
  let ry = 0
  let rz = 0
  if (u < p1) {
    const t = u / p1
    const coil = t * t * (3 - 2 * t)
    rx = coil * 0.26
    ry = -coil * 1.35
    rz = coil * 0.12
    rx += Math.sin(t * Math.PI * 2.5) * 0.018 * coil
  } else if (u < p2) {
    const t = (u - p1) / (p2 - p1)
    const snap = 1 - (1 - t) ** 3.2
    const ry0 = -1.35
    const ry1 = 1.12
    rx = 0.26 + snap * (-0.92 - 0.26)
    ry = ry0 + snap * (ry1 - ry0)
    rz = 0.12 + snap * 0.62
    rx += Math.sin(t * Math.PI * 4) * 0.035 * (1 - t * 0.5)
  } else {
    const t = (u - p2) / (1 - p2)
    const settle = t * t * (3 - 2 * t)
    const rxS = -0.66
    const ryS = 1.12
    const rzS = 0.74
    rx = rxS + settle * (0 - rxS) + Math.sin(t * Math.PI * 7) * 0.055 * (1 - settle)
    ry = ryS + settle * (0 - ryS) + Math.sin(t * Math.PI * 5.5) * 0.04 * (1 - settle)
    rz = rzS + settle * (0 - rzS)
  }
  g.rotation.set(rx, ry, rz)
}
const CTF_STUN_DURATION = 1.35
const CTF_RESPAWN_DELAY = 2.4
const CTF_SCORE_TO_WIN = 5
const P2_MOVE_SPEED = 10.5
const P1_MOVE_SPEED = 10
const WORLD_GRAVITY = 38
const WORLD_JUMP_VEL = 10.5
const JUMP_GROUND_EPS = 0.09
const CTF_PLAYER_SPAWN_X = [
  Math.round(-MAP_HALF_X * 0.48),
  Math.round(MAP_HALF_X * 0.48),
]

/** WC3 느낌: 금빛 장갑 포인터 (클릭 팁 ≈ 좌상단) */
const CURSOR_RTS_GAUNTLET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <path d="M5 3 L5 19 L9 23 L11 21 L10 17 L14 21 L17 18 L13 14 L17 13 L12 8 L9 10 L9 6 L7 4 Z"
    fill="#c9a227" stroke="#3d2914" stroke-width="1.25" stroke-linejoin="round"/>
  <path d="M8 8 L8 16 L12 19" fill="none" stroke="#6d4c1a" stroke-width="1.1" stroke-linecap="round"/>
  <path d="M12 9 L15 12 L13 15" fill="none" stroke="#5c4010" stroke-width="0.9"/>
</svg>`
const CURSOR_RTS_GAUNTLET = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(CURSOR_RTS_GAUNTLET_SVG)}") 5 3, pointer`

const WEAPONS = {
  mg: {
    id: 'mg',
    name: '기관총',
    keyLabel: '1',
    cooldown: 0.2,
    damage: 10,
    speed: 24,
    recoil: 0.38,
    bulletColor: '#ff7a45',
    bulletEmissive: '#6a1f00',
    emissiveIntensity: 0.45,
    bulletRadius: BULLET_HIT_RADIUS * 1.05,
  },
  sniper: {
    id: 'sniper',
    name: '스나이퍼',
    keyLabel: '2',
    cooldown: 2,
    damage: 50,
    speed: 40,
    recoil: 1,
    bulletColor: '#ff1744',
    bulletEmissive: '#4a0018',
    emissiveIntensity: 0.65,
    bulletRadius: BULLET_HIT_RADIUS * 1.12,
  },
  club: {
    id: 'club',
    name: '몽둥이',
    keyLabel: '3',
    cooldown: 0.41,
    damage: CLUB_MELEE_DAMAGE,
    speed: 0,
    recoil: 0.04,
    bulletColor: '#5d4037',
    bulletEmissive: '#000000',
    emissiveIntensity: 0,
    bulletRadius: BULLET_HIT_RADIUS,
  },
}

function grantWorldCrateLoot(loadoutRef, currentWeaponIdRef) {
  const L = loadoutRef.current
  if (Math.random() < 0.5) {
    L.ownedMg = true
    L.ammo += MG_START_AMMO
    currentWeaponIdRef.current = 'mg'
  } else {
    L.ownedSniper = true
    L.ammo += SNIPER_START_AMMO
    currentWeaponIdRef.current = 'sniper'
  }
}

function nowSec() {
  return performance.now() * 0.001
}

/** 조준 UI용 작은 삼각 표시 */
function createAimCornerArrowGeometry() {
  const shape = new THREE.Shape()
  shape.moveTo(0, 0.95)
  shape.lineTo(-0.32, 0)
  shape.lineTo(0.32, 0)
  shape.lineTo(0, 0.95)
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false })
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, 0.03, 0)
  return geo
}

/** WC3 이동 목표: 굵은 몸통 + 화살촉, 바닥에 놓을 때 +Z가 진행 방향 */
function createWc3MoveArrowGeometry() {
  const s = new THREE.Shape()
  const stemW = 0.22
  const stemBack = -0.62
  const stemFront = -0.02
  const headW = 0.58
  const tip = 0.72
  s.moveTo(-stemW / 2, stemBack)
  s.lineTo(stemW / 2, stemBack)
  s.lineTo(stemW / 2, stemFront)
  s.lineTo(headW / 2, stemFront)
  s.lineTo(0, tip)
  s.lineTo(-headW / 2, stemFront)
  s.lineTo(-stemW / 2, stemFront)
  s.closePath()
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.055, bevelEnabled: false })
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, 0.04, 0.08)
  return geo
}

function tryJumpFromGround(posRef, vyRef) {
  const pos = posRef.current
  const g = terrainHeight(pos.x, pos.z)
  if (vyRef.current > 0.4) return
  if (pos.y > g + JUMP_GROUND_EPS + 0.04) return
  vyRef.current = WORLD_JUMP_VEL
}

function integratePlayerVertical(pos, vyRef, delta) {
  const g = terrainHeight(pos.x, pos.z)
  if (vyRef.current <= 0 && pos.y <= g + JUMP_GROUND_EPS) {
    pos.y = g
    vyRef.current = 0
    return
  }
  vyRef.current -= WORLD_GRAVITY * delta
  pos.y += vyRef.current * delta
  if (pos.y < g) {
    pos.y = g
    if (vyRef.current < 0) vyRef.current = 0
  }
}

function terrainHeight(x, z) {
  let h = 0
  h += Math.sin(x * 0.092) * Math.cos(z * 0.088) * 2.35
  h += Math.sin(x * 0.047 + 0.9) * Math.sin(z * 0.053) * 1.95
  h += Math.cos(x * 0.11 + z * 0.09) * 1.15
  h += Math.sin((x + z) * 0.062) * 0.85
  h += Math.sin((x * x + z * z) * 0.00085) * 0.55
  return THREE.MathUtils.clamp(h, -0.15, 4.25)
}

function sightVignetteFactor(eyeX, eyeZ, targetX, targetZ) {
  const d = Math.hypot(targetX - eyeX, targetZ - eyeZ)
  if (d >= SIGHT_RADIUS) return 0
  return Math.pow(1 - d / SIGHT_RADIUS, VISION_VIG_POWER)
}

/** 눈보다 높은 지형·목표는 절대 안 보임 + 거리 비네트 + 중간 지형 가림 */
function terrainLineOfSight(eyeX, eyeY, eyeZ, targetX, targetY, targetZ) {
  if (targetY > eyeY + VISION_HEIGHT_SLACK) return false
  const vf = sightVignetteFactor(eyeX, eyeZ, targetX, targetZ)
  if (vf < VISION_MIN_FACTOR) return false

  const dx = targetX - eyeX
  const dy = targetY - eyeY
  const dz = targetZ - eyeZ
  const lim = LOS_STEPS
  const losEps =
    targetY <= eyeY + VISION_LOOKDOWN_RELAX_Y ? VISION_LOOKDOWN_LOS_EPS : LOS_CLEAR_EPS
  for (let i = 1; i < lim; i++) {
    const t = i / lim
    const x = eyeX + dx * t
    const z = eyeZ + dz * t
    const yLine = eyeY + dy * t
    const yGround = terrainHeight(x, z)
    if (yGround > yLine + losEps) return false
  }
  return true
}

function createTerrainGeometry() {
  const geo = new THREE.PlaneGeometry(TERRAIN_W, TERRAIN_D, TERRAIN_SEG_X, TERRAIN_SEG_Z)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    pos.setY(i, terrainHeight(x, z))
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

function randomEnemyPosition(pillars) {
  let x
  let z
  let s = 0
  do {
    x = (Math.random() * 2 - 1) * (MAP_HALF_X - 4)
    z = (Math.random() * 2 - 1) * (MAP_HALF_Z - 4)
    s++
  } while (
    ((x / (MAP_HALF_X * 0.19)) ** 2 + (z / (MAP_HALF_Z * 0.19)) ** 2 < 1 ||
      !isCircleClearOfPillars(x, z, ENEMY_RADIUS_XZ, pillars)) &&
    s < 400
  )
  return [x, terrainHeight(x, z) + ENEMY_HALF.y, z]
}

/** MMO 등: 맵 중앙 소외 구역 밖·기둥과 겹치지 않는 스폰 */
function randomOpenWorldSpawnXZ(pillars) {
  let x
  let z
  let s = 0
  do {
    x = (Math.random() * 2 - 1) * (MAP_HALF_X - 6)
    z = (Math.random() * 2 - 1) * (MAP_HALF_Z - 6)
    s++
  } while (
    ((x / (MAP_HALF_X * 0.19)) ** 2 + (z / (MAP_HALF_Z * 0.19)) ** 2 < 1 ||
      !isCircleClearOfPillars(x, z, PLAYER_R, pillars)) &&
    s < 650
  )
  return [x, z]
}

/** HP 회복 팩 스폰 (기둥·중앙 소외 구역 회피) */
function randomHpPackXZ(pillars) {
  let x
  let z
  let s = 0
  const r = 0.52
  do {
    x = (Math.random() * 2 - 1) * (MAP_HALF_X - 5)
    z = (Math.random() * 2 - 1) * (MAP_HALF_Z - 5)
    s++
  } while (
    ((x / (MAP_HALF_X * 0.19)) ** 2 + (z / (MAP_HALF_Z * 0.19)) ** 2 < 1 ||
      !isCircleClearOfPillars(x, z, r, pillars)) &&
    s < 500
  )
  return [x, z]
}

const MMO_REMOTE_MAX = 64
const mmoInstDummy = new THREE.Object3D()

function MmoRemoteInstancedMesh({ peersRef, mySlot }) {
  const meshRef = useRef(null)
  const geo = useMemo(() => new THREE.CapsuleGeometry(0.28, 0.75, 5, 10), [])
  const mat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#ba68c8',
        roughness: 0.48,
        metalness: 0.14,
        emissive: '#6a1b9a',
        emissiveIntensity: 0.22,
      }),
    [],
  )

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh) return
    let i = 0
    const peers = peersRef?.current
    if (peers && mySlot != null) {
      for (const [slot, pose] of peers) {
        if (slot === mySlot) continue
        if (!pose || typeof pose.x !== 'number' || typeof pose.z !== 'number') continue
        if (i >= MMO_REMOTE_MAX) break
        const y =
          typeof pose.y === 'number' ? pose.y : terrainHeight(pose.x, pose.z)
        mmoInstDummy.position.set(pose.x, y, pose.z)
        mmoInstDummy.rotation.set(0, pose.ry ?? 0, 0)
        mmoInstDummy.updateMatrix()
        mesh.setMatrixAt(i, mmoInstDummy.matrix)
        i++
      }
    }
    mesh.count = i
    mesh.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh ref={meshRef} args={[geo, mat, MMO_REMOTE_MAX]} frustumCulled={false} castShadow receiveShadow />
  )
}

function HpPickupOrb({ id, pickupsRef, eyeRef }) {
  const g = useRef(null)
  useFrame((state) => {
    const pk = pickupsRef.current?.get(id)
    if (!pk || !g.current) return
    const t = nowSec()
    if (t < pk.respawnUntil) {
      g.current.visible = false
      return
    }
    const bob = Math.sin(state.clock.elapsedTime * 2.6 + (id.charCodeAt(4) || 0)) * 0.08
    const h = terrainHeight(pk.x, pk.z) + 0.5 + bob
    g.current.position.set(pk.x, h, pk.z)
    g.current.rotation.y = state.clock.elapsedTime * 0.9
    const e = eyeRef.current
    const dx = pk.x - e.x
    const dz = pk.z - e.z
    const seen =
      dx * dx + dz * dz <= SIGHT_RADIUS * SIGHT_RADIUS &&
      terrainLineOfSight(e.x, e.y, e.z, pk.x, h, pk.z)
    g.current.visible = seen
  })
  return (
    <group ref={g}>
      <mesh castShadow>
        <icosahedronGeometry args={[0.28, 0]} />
        <meshStandardMaterial
          color="#00e676"
          emissive="#1b5e20"
          emissiveIntensity={0.62}
          roughness={0.32}
          metalness={0.18}
        />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.42, 0.04, 8, 28]} />
        <meshStandardMaterial
          color="#b9f6ca"
          emissive="#00c853"
          emissiveIntensity={0.4}
          transparent
          opacity={0.88}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

function AmmoPickupOrb({ id, pickupsRef, eyeRef }) {
  const g = useRef(null)
  useFrame((state) => {
    const pk = pickupsRef.current?.get(id)
    if (!pk || !g.current) return
    const t = nowSec()
    if (t < pk.respawnUntil) {
      g.current.visible = false
      return
    }
    const bob = Math.sin(state.clock.elapsedTime * 3.1 + (id.charCodeAt(3) || 0)) * 0.07
    const h = terrainHeight(pk.x, pk.z) + 0.48 + bob
    g.current.position.set(pk.x, h, pk.z)
    g.current.rotation.y = state.clock.elapsedTime * 1.2
    const e = eyeRef.current
    const dx = pk.x - e.x
    const dz = pk.z - e.z
    const seen =
      dx * dx + dz * dz <= SIGHT_RADIUS * SIGHT_RADIUS &&
      terrainLineOfSight(e.x, e.y, e.z, pk.x, h, pk.z)
    g.current.visible = seen
  })
  return (
    <group ref={g}>
      <mesh castShadow>
        <boxGeometry args={[0.32, 0.22, 0.18]} />
        <meshStandardMaterial
          color="#ffb300"
          emissive="#ff6f00"
          emissiveIntensity={0.48}
          roughness={0.35}
          metalness={0.28}
        />
      </mesh>
    </group>
  )
}

function LootCrateUnit({ id, cratesRef, eyeRef }) {
  const g = useRef(null)
  useFrame(() => {
    const c = cratesRef.current?.get(id)
    if (!c || !g.current) {
      if (g.current) g.current.visible = false
      return
    }
    const y = terrainHeight(c.x, c.z) + CRATE_HALF.y
    g.current.position.set(c.x, y, c.z)
    const ek = eyeRef.current
    const dx = c.x - ek.x
    const dz = c.z - ek.z
    const distSq = dx * dx + dz * dz
    const seen =
      distSq <= SIGHT_RADIUS * SIGHT_RADIUS &&
      terrainLineOfSight(ek.x, ek.y, ek.z, c.x, y, c.z)
    g.current.visible = seen
  })
  return (
    <group ref={g}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[CRATE_HALF.x * 2, CRATE_HALF.y * 2, CRATE_HALF.z * 2]} />
        <meshStandardMaterial
          color="#6d4c41"
          roughness={0.72}
          metalness={0.12}
          emissive="#3e2723"
          emissiveIntensity={0.12}
        />
      </mesh>
    </group>
  )
}

function sphereIntersectsBox(px, py, pz, cx, cy, cz, hx, hy, hz, r) {
  const dx = Math.max(Math.abs(px - cx) - hx, 0)
  const dy = Math.max(Math.abs(py - cy) - hy, 0)
  const dz = Math.max(Math.abs(pz - cz) - hz, 0)
  return dx * dx + dy * dy + dz * dz < r * r
}

function clampXZToArena(x, z, radius) {
  const mx = MAP_HALF_X - radius - 0.02
  const mz = MAP_HALF_Z - radius - 0.02
  return [Math.max(-mx, Math.min(mx, x)), Math.max(-mz, Math.min(mz, z))]
}

function resolveCircleFromPillars(x, z, radius, pillars) {
  let px = x
  let pz = z
  for (const col of pillars) {
    const dx = px - col.x
    const dz = pz - col.z
    const d = Math.hypot(dx, dz)
    const minD = col.r + radius + 0.015
    if (d < 1e-5) {
      px = col.x + minD
      continue
    }
    if (d < minD) {
      const push = (minD - d) / d
      px += dx * push
      pz += dz * push
    }
  }
  return [px, pz]
}

function resolveBodyInArena(x, z, radius, pillars, iterations = 4) {
  let px = x
  let pz = z
  for (let i = 0; i < iterations; i++) {
    ;[px, pz] = clampXZToArena(px, pz, radius)
    ;[px, pz] = resolveCircleFromPillars(px, pz, radius, pillars)
  }
  return [px, pz]
}

function sphereIntersectsPillar(px, py, pz, br, pillar) {
  const dx = px - pillar.x
  const dz = pz - pillar.z
  if (dx * dx + dz * dz > (pillar.r + br) ** 2) return false
  const g = terrainHeight(pillar.x, pillar.z)
  const y0 = g
  const y1 = g + PILLAR_HEIGHT
  return py >= y0 - br && py <= y1 + br
}

function isCircleClearOfPillars(x, z, r, pillars) {
  for (const c of pillars) {
    const dx = x - c.x
    const dz = z - c.z
    if (dx * dx + dz * dz < (c.r + r + 0.2) ** 2) return false
  }
  return true
}

function distXZSq(ax, az, bx, bz) {
  const dx = ax - bx
  const dz = az - bz
  return dx * dx + dz * dz
}

function ctfFlagWorldXZ(team) {
  return [CTF_BASE_CENTER_X[team], CTF_FLAG_POLE_Z[team]]
}

function createCtfFlagState() {
  return {
    0: { mode: 'base', carrierKey: null, ground: new THREE.Vector3() },
    1: { mode: 'base', carrierKey: null, ground: new THREE.Vector3() },
  }
}

function playerInOwnBase(team, x, z) {
  const bx = CTF_BASE_CENTER_X[team]
  return distXZSq(x, z, bx, 0) <= CTF_BASE_RADIUS * CTF_BASE_RADIUS
}

function ctfPlayerCarryingFlag(ctf, playerKey) {
  return [0, 1].some(
    (tid) =>
      ctf.flags[tid].mode === 'carried' && ctf.flags[tid].carrierKey === playerKey,
  )
}

function worldToMinimapPx(x, z, halfX, halfZ, ix, iy, iw, ih) {
  const nx = (x + halfX) / (2 * halfX)
  const nz = (z + halfZ) / (2 * halfZ)
  return {
    px: ix + nx * iw,
    py: iy + (1 - nz) * ih,
  }
}

/** 미니맵용 깃발 위치 — 금링·깃발 도형·「아군/적군 깃발」글자로 유닛 점과 확실히 구분 */
function drawMinimapFlagMarker(ctx, px, py, team) {
  const fill = team === 0 ? '#42a5f5' : '#ff7043'
  const fillDark = team === 0 ? '#0d47a1' : '#bf360c'
  const label = team === 0 ? '아군 깃발' : '적군 깃발'

  ctx.strokeStyle = 'rgba(255, 235, 59, 1)'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(px, py, 8.5, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = fill
  ctx.strokeStyle = 'rgba(0,0,0,0.9)'
  ctx.lineWidth = 1.25
  const poleL = 7.5
  ctx.beginPath()
  ctx.moveTo(px - 0.6, py + poleL * 0.65)
  ctx.lineTo(px - 0.6, py - poleL)
  ctx.lineTo(px + 0.6, py - poleL)
  ctx.lineTo(px + 0.6, py + poleL * 0.65)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = fillDark
  ctx.beginPath()
  ctx.moveTo(px + 0.6, py - poleL)
  ctx.lineTo(px + 7.5, py - 4.5)
  ctx.lineTo(px + 0.6, py - 1.5)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const ty = py + 11
  ctx.font = '700 9px system-ui, "Malgun Gothic", sans-serif'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(0,0,0,0.92)'
  ctx.strokeText(label, px, ty)
  ctx.fillStyle = team === 0 ? '#e3f2fd' : '#fff3e0'
  ctx.fillText(label, px, ty)
}

/** 워크래프트3 느낌: 금테 두꺼운 프레임, 진영 색, 유닛 점 */
function Wc3Minimap({ dataRef }) {
  const canvasRef = useRef(null)
  const rafRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const CSS = 228
    const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
    canvas.width = Math.round(CSS * dpr)
    canvas.height = Math.round(CSS * dpr)
    canvas.style.width = `${CSS}px`
    canvas.style.height = `${CSS}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const gold = '#c9a227'
    const goldDark = '#6d5220'
    const frameOut = '#1a0d08'
    const frameIn = '#2d1810'

    const border = 5
    const bevel = 2
    const innerX = border + bevel + 4
    const innerY = border + bevel + 4
    const innerW = CSS - 2 * innerX
    const innerH = CSS - 2 * innerY
    const grdW = ctx.createLinearGradient(innerX, 0, innerX + innerW * 0.5, 0)
    grdW.addColorStop(0, 'rgba(28, 62, 140, 0.94)')
    grdW.addColorStop(1, 'rgba(40, 88, 168, 0.88)')
    const grdE = ctx.createLinearGradient(innerX + innerW * 0.5, 0, innerX + innerW, 0)
    grdE.addColorStop(0, 'rgba(140, 38, 28, 0.9)')
    grdE.addColorStop(1, 'rgba(100, 26, 20, 0.88)')

    const MINIMAP_FPS = 12
    const minimapFrameMs = 1000 / MINIMAP_FPS
    let lastMiniT = 0

    const tick = (tDom) => {
      if (tDom - lastMiniT < minimapFrameMs) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      lastMiniT = tDom

      const d = dataRef.current
      const W = CSS
      const H = CSS
      ctx.clearRect(0, 0, W, H)

      ctx.fillStyle = frameOut
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = goldDark
      ctx.fillRect(border, border, W - border * 2, H - border * 2)
      ctx.fillStyle = frameIn
      ctx.fillRect(border + bevel, border + bevel, W - 2 * (border + bevel), H - 2 * (border + bevel))

      const hx = d?.mapHalfX ?? MAP_HALF_X
      const hz = d?.mapHalfZ ?? MAP_HALF_Z

      ctx.fillStyle = grdW
      ctx.fillRect(innerX, innerY, innerW * 0.5, innerH)

      ctx.fillStyle = grdE
      ctx.fillRect(innerX + innerW * 0.5, innerY, innerW * 0.5, innerH)

      ctx.strokeStyle = 'rgba(201, 162, 39, 0.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(innerX + innerW * 0.5, innerY)
      ctx.lineTo(innerX + innerW * 0.5, innerY + innerH)
      ctx.stroke()

      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 0.5
      for (let i = 1; i < 4; i++) {
        const gx = innerX + (innerW * i) / 4
        ctx.beginPath()
        ctx.moveTo(gx, innerY)
        ctx.lineTo(gx, innerY + innerH)
        ctx.stroke()
        const gy = innerY + (innerH * i) / 4
        ctx.beginPath()
        ctx.moveTo(innerX, gy)
        ctx.lineTo(innerX + innerW, gy)
        ctx.stroke()
      }

      ctx.strokeStyle = gold
      ctx.lineWidth = 1.25
      ctx.strokeRect(innerX + 0.5, innerY + 0.5, innerW - 1, innerH - 1)

      const toMini = (wx, wz) => worldToMinimapPx(wx, wz, hx, hz, innerX, innerY, innerW, innerH)

      if (isCtfGameMode(d?.mode)) {
        const sx = innerW / (2 * hx)
        const sz = innerH / (2 * hz)
        const brPx = CTF_BASE_RADIUS * Math.min(sx, sz)
        for (let tm = 0; tm < 2; tm++) {
          const bx = CTF_BASE_CENTER_X[tm]
          const { px, py } = toMini(bx, 0)
          ctx.strokeStyle =
            tm === 0 ? 'rgba(100, 170, 255, 0.65)' : 'rgba(255, 150, 110, 0.65)'
          ctx.lineWidth = 1.25
          ctx.setLineDash([3, 2])
          ctx.beginPath()
          ctx.arc(px, py, Math.max(4, brPx), 0, Math.PI * 2)
          ctx.stroke()
          ctx.setLineDash([])
        }
      }

      if (d?.enemies?.length) {
        ctx.fillStyle = 'rgba(255, 80, 80, 0.95)'
        for (const en of d.enemies) {
          const { px, py } = toMini(en.x, en.z)
          ctx.fillRect(px - 1.2, py - 1.2, 2.4, 2.4)
        }
      }

      if (Array.isArray(d?.hpPacks) && d.hpPacks.length) {
        ctx.fillStyle = 'rgba(40, 220, 120, 0.95)'
        for (const pk of d.hpPacks) {
          if (pk == null || typeof pk.x !== 'number') continue
          const { px, py } = toMini(pk.x, pk.z)
          ctx.beginPath()
          ctx.moveTo(px, py - 3.2)
          ctx.lineTo(px + 2.8, py)
          ctx.lineTo(px, py + 3.2)
          ctx.lineTo(px - 2.8, py)
          ctx.closePath()
          ctx.fill()
          ctx.strokeStyle = 'rgba(0,60,30,0.85)'
          ctx.lineWidth = 0.75
          ctx.stroke()
        }
      }

      if (d?.p0 && d.p0.alive) {
        const { px, py } = toMini(d.p0.x, d.p0.z)
        ctx.fillStyle = '#2979ff'
        ctx.beginPath()
        ctx.arc(px, py, d.p0.carry ? 4 : 3.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#0d1b2a'
        ctx.lineWidth = 1
        ctx.stroke()
      }
      if (d?.p1 && d.p1.alive) {
        const { px, py } = toMini(d.p1.x, d.p1.z)
        ctx.fillStyle = '#ff6f00'
        ctx.beginPath()
        ctx.arc(px, py, d.p1.carry ? 4 : 3.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#0d1b2a'
        ctx.lineWidth = 1
        ctx.stroke()
      }

      if (isCtfGameMode(d?.mode) && Array.isArray(d.flags)) {
        for (const fl of d.flags) {
          if (fl == null || typeof fl.x !== 'number') continue
          const { px, py } = toMini(fl.x, fl.z)
          drawMinimapFlagMarker(ctx, px, py, fl.team)
        }
      }

      if (d?.mode === GAME_MODE_MMO_ONLINE && Array.isArray(d.peers)) {
        for (const pr of d.peers) {
          if (pr == null || typeof pr.x !== 'number') continue
          const { px, py } = toMini(pr.x, pr.z)
          ctx.fillStyle = 'rgba(206, 147, 216, 0.95)'
          ctx.beginPath()
          ctx.arc(px, py, 2.8, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = '#4a148c'
          ctx.lineWidth = 0.75
          ctx.stroke()
        }
      }

      ctx.fillStyle = 'rgba(240, 230, 200, 0.95)'
      ctx.font = '600 9px system-ui,sans-serif'
      ctx.textAlign = 'left'
      if (isCtfGameMode(d?.mode)) {
        ctx.fillText('아군 서(좌) · 적 동(우)', innerX + 3, innerY + 10)
        ctx.fillStyle = 'rgba(255, 235, 150, 0.92)'
        ctx.font = '600 8px system-ui,sans-serif'
        ctx.fillText('금링+글자 = 깃발 (아군/적군)', innerX + 3, innerY + 21)
      } else if (d?.mode === GAME_MODE_MMO_ONLINE) {
        ctx.fillText('MMO · 붉은 네모=적 · 보라=유저 · 녹색 마름모=HP팩', innerX + 3, innerY + 10)
        ctx.fillStyle = 'rgba(200, 200, 200, 0.85)'
        ctx.font = '600 7.5px system-ui,sans-serif'
        ctx.fillText('파란 점 = 나 · HP 초당 감소 · 팩에서 회복', innerX + 3, innerY + 21)
      } else {
        ctx.fillStyle = 'rgba(240, 230, 200, 0.95)'
        ctx.fillText('솔로 · 붉은 네모=적 · 녹색 마름모=HP 팩', innerX + 3, innerY + 10)
        ctx.fillStyle = 'rgba(200, 200, 200, 0.85)'
        ctx.font = '600 7.5px system-ui,sans-serif'
        ctx.fillText('생존 HP 감소 · 팩 +25 · 깃발은 로컬 2인 모드', innerX + 3, innerY + 21)
      }

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [dataRef])

  return (
    <div
      style={{
        position: 'fixed',
        left: 10,
        bottom: 96,
        zIndex: 8,
        pointerEvents: 'none',
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  )
}

function CtfTerritoryTint() {
  const wHalf = MAP_HALF_X - 4
  const zSpan = MAP_HALF_Z * 2 - 8
  const y = 0.11
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-MAP_HALF_X / 2, y, 0]}>
        <planeGeometry args={[wHalf, zSpan]} />
        <meshBasicMaterial color="#2f5cb8" transparent opacity={0.14} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[MAP_HALF_X / 2, y, 0]}>
        <planeGeometry args={[wHalf, zSpan]} />
        <meshBasicMaterial color="#b83a2f" transparent opacity={0.14} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y + 0.02, 0]}>
        <planeGeometry args={[0.4, zSpan]} />
        <meshBasicMaterial color="#c9a227" transparent opacity={0.55} depthWrite={false} />
      </mesh>
    </group>
  )
}

function generatePillars() {
  const list = []
  let tries = 0
  while (list.length < PILLAR_COUNT && tries < 650) {
    tries++
    const x = (Math.random() * 2 - 1) * (MAP_HALF_X - PILLAR_RADIUS - 3)
    const z = (Math.random() * 2 - 1) * (MAP_HALF_Z - PILLAR_RADIUS - 3)
    if ((x / (MAP_HALF_X * 0.34)) ** 2 + (z / (MAP_HALF_Z * 0.34)) ** 2 < 1) continue
    let ok = true
    for (const o of list) {
      const dx = o.x - x
      const dz = o.z - z
      if (dx * dx + dz * dz < (2 * PILLAR_RADIUS + 1.35) ** 2) {
        ok = false
        break
      }
    }
    if (!ok) continue
    list.push({ x, z, r: PILLAR_RADIUS })
  }
  return list
}

function CtfFlagVisual({ team, ctfRef, playerPosRef, player2PosRef, eyeRef, gameMode }) {
  const rootRef = useRef(null)
  const colors = team === 0 ? ['#1565c0', '#42a5f5'] : ['#c62828', '#ff8a80']

  useFrame(() => {
    if (!isCtfGameMode(gameMode) || !rootRef.current) return
    const f = ctfRef.current.flags[team]
    const [px, pz] = ctfFlagWorldXZ(team)
    let x = px
    let z = pz
    let y = terrainHeight(px, pz) + 0.05
    if (f.mode === 'carried' && f.carrierKey) {
      const pos = f.carrierKey === 'p0' ? playerPosRef.current : player2PosRef.current
      if (pos) {
        x = pos.x + (team === 0 ? 0.42 : -0.42)
        z = pos.z
        y = pos.y + 1.12
      }
    } else if (f.mode === 'ground') {
      x = f.ground.x
      z = f.ground.z
      y = f.ground.y + 0.12
    }
    rootRef.current.position.set(x, y, z)
    const e = eyeRef.current
    const dx = x - e.x
    const dz = z - e.z
    const inR = dx * dx + dz * dz <= SIGHT_RADIUS * SIGHT_RADIUS
    rootRef.current.visible =
      inR && terrainLineOfSight(e.x, e.y, e.z, x, y + 0.6, z)
  })

  return (
    <group ref={rootRef}>
      <mesh castShadow position={[0, 0.65, 0]}>
        <cylinderGeometry args={[0.06, 0.07, 1.35, 8]} />
        <meshStandardMaterial color="#5d4037" roughness={0.75} />
      </mesh>
      <mesh
        castShadow
        position={[team === 0 ? 0.32 : -0.32, 1.02, 0]}
        rotation={[0, 0, team === 0 ? -0.12 : 0.12]}
      >
        <planeGeometry args={[0.52, 0.38]} />
        <meshStandardMaterial
          color={colors[0]}
          emissive={colors[1]}
          emissiveIntensity={0.25}
          side={THREE.DoubleSide}
          roughness={0.55}
        />
      </mesh>
    </group>
  )
}

/** 깃발 실제 위치를 맵 위에 항상 보이게 (시야 가림 무시, 거리만 제한) */
function CtfFlagMapIndicator({ team, ctfRef, playerPosRef, player2PosRef, playerEyeRef, gameMode }) {
  const rootRef = useRef(null)
  const col = team === 0 ? '#1565c0' : '#c62828'
  const colEm = team === 0 ? '#42a5f5' : '#ff8a80'

  useFrame(() => {
    if (!isCtfGameMode(gameMode) || !rootRef.current) return
    const f = ctfRef.current.flags[team]
    const [px, pz] = ctfFlagWorldXZ(team)
    let x = px
    let z = pz
    let y = terrainHeight(px, pz) + 0.14
    if (f.mode === 'carried' && f.carrierKey) {
      const pos = f.carrierKey === 'p0' ? playerPosRef.current : player2PosRef.current
      if (pos) {
        x = pos.x + (team === 0 ? 0.42 : -0.42)
        z = pos.z
        y = terrainHeight(x, z) + 0.14
      }
    } else if (f.mode === 'ground') {
      x = f.ground.x
      z = f.ground.z
      y = f.ground.y + 0.14
    }
    rootRef.current.position.set(x, y, z)
    const e = playerEyeRef.current
    const d2 = distXZSq(x, z, e.x, e.z)
    const far = SIGHT_RADIUS * 1.85
    rootRef.current.visible = d2 <= far * far
  })

  return (
    <group ref={rootRef}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.45, 2.85, 40]} />
        <meshBasicMaterial
          color="#ffeb3b"
          transparent
          opacity={0.42}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <ringGeometry args={[1.65, 2.05, 40]} />
        <meshBasicMaterial
          color={col}
          transparent
          opacity={0.38}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, 1.35, 0]}>
        <octahedronGeometry args={[0.38, 0]} />
        <meshStandardMaterial
          color={col}
          emissive={colEm}
          emissiveIntensity={0.85}
          roughness={0.35}
          metalness={0.15}
          transparent
          opacity={0.92}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

function CtfBaseZone({ team, eyeRef }) {
  const meshRef = useRef(null)
  const bx = CTF_BASE_CENTER_X[team]
  const col = team === 0 ? '#1e88e5' : '#e53935'

  useFrame(() => {
    if (!meshRef.current) return
    const y = terrainHeight(bx, 0) + 0.08
    meshRef.current.position.set(bx, y, 0)
    const e = eyeRef.current
    const inR = distXZSq(bx, 0, e.x, e.z) <= SIGHT_RADIUS * SIGHT_RADIUS
    meshRef.current.visible =
      inR && terrainLineOfSight(e.x, e.y, e.z, bx, y + 0.5, 0)
  })

  return (
    <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[CTF_BASE_RADIUS - 0.35, CTF_BASE_RADIUS, 48]} />
      <meshStandardMaterial
        color={col}
        transparent
        opacity={0.22}
        depthWrite={false}
        roughness={0.9}
      />
    </mesh>
  )
}

function PillarLoS({ col, eyeRef }) {
  const g = useRef(null)
  const gy = useMemo(() => terrainHeight(col.x, col.z), [col.x, col.z])
  const cy = gy + PILLAR_CENTER_Y
  useFrame(() => {
    if (!g.current) return
    const e = eyeRef.current
    const ddx = col.x - e.x
    const ddz = col.z - e.z
    const inR = ddx * ddx + ddz * ddz <= SIGHT_RADIUS * SIGHT_RADIUS
    g.current.visible =
      inR && terrainLineOfSight(e.x, e.y, e.z, col.x, cy, col.z)
  })
  return (
    <group ref={g}>
      <mesh position={[col.x, cy, col.z]} castShadow receiveShadow>
        <cylinderGeometry args={[col.r, col.r, PILLAR_HEIGHT, 14]} />
        <meshStandardMaterial color="#8c919b" roughness={0.82} metalness={0.22} />
      </mesh>
    </group>
  )
}

function CameraRig({ targetRef, zoomTargetRef, orbitYawRef, orbitPitchRef, hitFxRef }) {
  const { camera } = useThree()
  const desired = useMemo(() => new THREE.Vector3(), [])
  const look = useMemo(() => new THREE.Vector3(), [])
  const offsetScratch = useMemo(() => new THREE.Vector3(), [])
  const orbitRightScratch = useMemo(() => new THREE.Vector3(), [])
  const shakeScratch = useMemo(() => new THREE.Vector3(), [])
  const yAxis = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const zoomSmooth = useRef(1)

  useFrame((_, delta) => {
    const t = targetRef.current
    if (!t) return
    const zk = 1 - Math.exp(-14 * delta)
    zoomSmooth.current += (zoomTargetRef.current - zoomSmooth.current) * zk

    const k = 1 - Math.exp(-5 * delta)
    offsetScratch.copy(CAM_OFFSET).multiplyScalar(zoomSmooth.current)
    offsetScratch.applyAxisAngle(yAxis, orbitYawRef.current)
    orbitRightScratch.crossVectors(yAxis, offsetScratch)
    if (orbitRightScratch.lengthSq() < 1e-10) {
      orbitRightScratch.set(1, 0, 0).applyAxisAngle(yAxis, orbitYawRef.current)
    } else {
      orbitRightScratch.normalize()
    }
    offsetScratch.applyAxisAngle(orbitRightScratch, orbitPitchRef.current)
    desired.copy(t.position).add(offsetScratch)
    camera.position.lerp(desired, k)

    const sh = hitFxRef?.current?.shake ?? 0
    if (sh > 0.004) {
      shakeScratch.set(
        (Math.random() - 0.5) * 2.4 * sh,
        (Math.random() - 0.5) * 1.5 * sh,
        (Math.random() - 0.5) * 2.4 * sh,
      )
      camera.position.add(shakeScratch)
    }

    look.copy(t.position)
    camera.lookAt(look.x, look.y + 0.75, look.z)
  })

  return null
}

function BulletMesh({ id, bulletsRef, eyeRef }) {
  const meshRef = useRef(null)
  const matRef = useRef(null)
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const qu = useMemo(() => new THREE.Quaternion(), [])

  useFrame(() => {
    const b = bulletsRef.current.get(id)
    if (!b || !meshRef.current) return
    meshRef.current.position.copy(b.pos)
    const dir = b.dir
    if (dir.lengthSq() > 1e-10) {
      qu.setFromUnitVectors(up, dir.clone().normalize())
      meshRef.current.quaternion.copy(qu)
    }
    const len = b.visLength ?? BULLET_VIS_LENGTH
    meshRef.current.scale.set(1, len, 1)
    const e = eyeRef.current
    const ddx = b.pos.x - e.x
    const ddz = b.pos.z - e.z
    const inR = ddx * ddx + ddz * ddz <= SIGHT_RADIUS * SIGHT_RADIUS
    meshRef.current.visible =
      inR && terrainLineOfSight(e.x, e.y, e.z, b.pos.x, b.pos.y, b.pos.z)
    if (matRef.current) {
      matRef.current.color.set(b.color ?? '#e02020')
      matRef.current.emissive.set(b.emissive ?? '#600000')
      matRef.current.emissiveIntensity = b.emissiveIntensity ?? 0.35
    }
  })
  return (
    <mesh ref={meshRef} castShadow>
      <cylinderGeometry args={[BULLET_VIS_RADIUS, BULLET_VIS_RADIUS, 1, 6]} />
      <meshStandardMaterial ref={matRef} color="#e02020" emissive="#600000" emissiveIntensity={0.35} />
    </mesh>
  )
}

function EnemyUnit({ id, enemiesRef, eyeRef }) {
  const bodyRef = useRef(null)
  const boxRef = useRef(null)
  const barRootRef = useRef(null)
  const greenFillRef = useRef(null)
  const { camera } = useThree()

  useFrame(() => {
    const e = enemiesRef.current.get(id)
    if (!e) return

    if (boxRef.current) boxRef.current.position.copy(e.pos)

    if (barRootRef.current) {
      barRootRef.current.position.set(e.pos.x, e.pos.y + ENEMY_HALF.y + 0.82, e.pos.z)
      barRootRef.current.quaternion.copy(camera.quaternion)
    }

    const ratio = Math.max(0, e.hp / e.maxHp)
    if (greenFillRef.current) {
      greenFillRef.current.scale.x = Math.max(0.001, ratio)
      greenFillRef.current.position.x = (BAR_WIDTH / 2) * (ratio - 1)
    }

    const ek = eyeRef.current
    const ddx = e.pos.x - ek.x
    const ddz = e.pos.z - ek.z
    const distSq = ddx * ddx + ddz * ddz
    const inRange = distSq <= SIGHT_RADIUS * SIGHT_RADIUS
    const bodySeen =
      inRange && terrainLineOfSight(ek.x, ek.y, ek.z, e.pos.x, e.pos.y, e.pos.z)
    if (bodyRef.current) bodyRef.current.visible = bodySeen
    if (barRootRef.current) barRootRef.current.visible = inRange
  })

  return (
    <group>
      <group ref={bodyRef}>
        <mesh ref={boxRef} castShadow receiveShadow>
          <boxGeometry args={[1, 1.5, 1]} />
          <meshStandardMaterial color="#c62828" roughness={0.5} metalness={0.12} emissive="#400808" emissiveIntensity={0.2} />
        </mesh>
      </group>

      <group ref={barRootRef} renderOrder={2}>
        <mesh position={[0, 0, 0.006]} renderOrder={2}>
          <planeGeometry args={[BAR_WIDTH + 0.08, BAR_H + 0.08]} />
          <meshBasicMaterial
            color="#2a1a1a"
            depthTest
            depthWrite={false}
            transparent
            opacity={0.75}
            toneMapped={false}
            fog={false}
          />
        </mesh>
        <mesh position={[0, 0, 0.012]} renderOrder={3}>
          <planeGeometry args={[BAR_WIDTH, BAR_H * 0.78]} />
          <meshBasicMaterial
            color="#ff1744"
            depthTest
            depthWrite={false}
            toneMapped={false}
            fog={false}
          />
        </mesh>
        <mesh ref={greenFillRef} position={[0, 0, 0.022]} renderOrder={4}>
          <planeGeometry args={[BAR_WIDTH, BAR_H * 0.72]} />
          <meshBasicMaterial
            color="#00ff66"
            depthTest
            depthWrite={false}
            toneMapped={false}
            fog={false}
          />
        </mesh>
      </group>
    </group>
  )
}

/** CTF 상대 체력바 (거리만 체크 — 언덕 뒤에도 체력은 보임) */
function CtfRemoteHpBar({ posRef, statsRef, eyeRef }) {
  const barRootRef = useRef(null)
  const greenFillRef = useRef(null)
  const { camera } = useThree()

  useFrame(() => {
    const st = statsRef.current
    const p = posRef.current
    if (!st || !p || !barRootRef.current) return
    barRootRef.current.position.set(p.x, p.y + ENEMY_HALF.y + 0.86, p.z)
    barRootRef.current.quaternion.copy(camera.quaternion)
    const ratio = st.alive ? Math.max(0, st.hp / st.maxHp) : 0
    if (greenFillRef.current) {
      greenFillRef.current.scale.x = Math.max(0.001, ratio)
      greenFillRef.current.position.x = (BAR_WIDTH / 2) * (ratio - 1)
    }
    const ek = eyeRef.current
    const inRange = distXZSq(p.x, p.z, ek.x, ek.z) <= SIGHT_RADIUS * SIGHT_RADIUS
    barRootRef.current.visible = inRange && st.alive
  })

  return (
    <group ref={barRootRef} renderOrder={2}>
      <mesh position={[0, 0.14, 0.006]} renderOrder={2}>
        <planeGeometry args={[BAR_WIDTH + 0.12, BAR_H + 0.1]} />
        <meshBasicMaterial
          color="#1a1a1a"
          depthTest
          depthWrite={false}
          transparent
          opacity={0.88}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, 0.14, 0.012]} renderOrder={3}>
        <planeGeometry args={[BAR_WIDTH, BAR_H * 0.8]} />
        <meshBasicMaterial color="#b71c1c" depthTest depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={greenFillRef} position={[0, 0.14, 0.022]} renderOrder={4}>
        <planeGeometry args={[BAR_WIDTH, BAR_H * 0.72]} />
        <meshBasicMaterial color="#00e676" depthTest depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}

/** 플레이어 캡슐 머리 위 — EnemyUnit과 동일한 직사각형 HP 바 */
function PlayerOverheadHpBar({ posRef, statsRef, eyeRef, requireAlive = true }) {
  const barRootRef = useRef(null)
  const greenFillRef = useRef(null)
  const { camera } = useThree()
  /** 캡슐 머리(약 y+1.1) 위로 더 띄움 */
  const barY = 1.62

  useFrame(() => {
    const st = statsRef.current
    const p = posRef.current
    if (!st || !p || !barRootRef.current) return
    const maxHp = st.maxHp ?? PLAYER_MAX_HP
    const hp = st.hp ?? 0
    const alive = st.alive !== false
    barRootRef.current.position.set(p.x, p.y + barY, p.z)
    barRootRef.current.quaternion.copy(camera.quaternion)
    const ratio =
      requireAlive && !alive ? 0 : Math.max(0, Math.min(1, hp / maxHp))
    if (greenFillRef.current) {
      greenFillRef.current.scale.x = Math.max(0.001, ratio)
      greenFillRef.current.position.x = (BAR_WIDTH / 2) * (ratio - 1)
    }
    const e = eyeRef.current
    const ddx = p.x - e.x
    const ddz = p.z - e.z
    const inRange = ddx * ddx + ddz * ddz <= SIGHT_RADIUS * SIGHT_RADIUS
    const bodyY = p.y + 0.75
    const seen = inRange && terrainLineOfSight(e.x, e.y, e.z, p.x, bodyY, p.z)
    if (requireAlive) {
      barRootRef.current.visible = inRange && seen && alive
    } else {
      barRootRef.current.visible = inRange && seen
    }
  })

  return (
    <group ref={barRootRef} renderOrder={2}>
      <mesh position={[0, 0, 0.006]} renderOrder={2}>
        <planeGeometry args={[BAR_WIDTH + 0.08, BAR_H + 0.08]} />
        <meshBasicMaterial
          color="#2a1a1a"
          depthTest
          depthWrite={false}
          transparent
          opacity={0.75}
          toneMapped={false}
          fog={false}
        />
      </mesh>
      <mesh position={[0, 0, 0.012]} renderOrder={3}>
        <planeGeometry args={[BAR_WIDTH, BAR_H * 0.78]} />
        <meshBasicMaterial
          color="#ff1744"
          depthTest
          depthWrite={false}
          toneMapped={false}
          fog={false}
        />
      </mesh>
      <mesh ref={greenFillRef} position={[0, 0, 0.022]} renderOrder={4}>
        <planeGeometry args={[BAR_WIDTH, BAR_H * 0.72]} />
        <meshBasicMaterial
          color="#00ff66"
          depthTest
          depthWrite={false}
          toneMapped={false}
          fog={false}
        />
      </mesh>
    </group>
  )
}

function packCtfForNet(flags) {
  const p = (f) => ({
    m: f.mode,
    k: f.carrierKey,
    gx: f.ground.x,
    gy: f.ground.y,
    gz: f.ground.z,
  })
  return { 0: p(flags[0]), 1: p(flags[1]) }
}

function applyCtfFromNet(ctf, packed) {
  if (!packed) return
  for (const tid of [0, 1]) {
    const s = packed[tid]
    if (!s) continue
    const f = ctf.flags[tid]
    f.mode = s.m
    f.carrierKey = s.k
    f.ground.set(s.gx, s.gy, s.gz)
  }
}

function dropCtfFlagsFromCarrier(ctf, carrierKey, gx, gy, gz) {
  for (const tid of [0, 1]) {
    const f = ctf.flags[tid]
    if (f.mode === 'carried' && f.carrierKey === carrierKey) {
      f.mode = 'ground'
      f.carrierKey = null
      f.ground.set(gx, gy, gz)
    }
  }
}

function GameScene({
  hudRefs,
  setGameCursor,
  gameMode,
  minimapDataRef,
  networkSlot = null,
  remoteBufferRef,
  remoteMmoPeersRef,
  mpBridgeRef,
  pendingHitRef,
  pendingMmoHitRef,
  hitFeedbackRef,
}) {
  const camZoomTarget = useRef(1)
  const camOrbitYawRef = useRef(0)
  const camOrbitPitchRef = useRef(0)
  const terrainMeshRef = useRef(null)
  const terrainUniformsRef = useRef(null)
  const playerEyeWorld = useRef(new THREE.Vector3())
  const playerRef = useRef(null)
  const player2Ref = useRef(null)
  const gunPivotRef = useRef(null)
  const gunPivot2Ref = useRef(null)
  const moveArrowRef = useRef(null)
  const moveArrowMatRef = useRef(null)
  const moveArrowRingMatRef = useRef(null)

  const pillars = useMemo(() => generatePillars(), [])
  const spawnXZ = useMemo(() => {
    if (isCtfGameMode(gameMode)) return [CTF_PLAYER_SPAWN_X[0], 0]
    if (gameMode === GAME_MODE_MMO_ONLINE) return randomOpenWorldSpawnXZ(pillars)
    return [0, 0]
  }, [gameMode, pillars])
  const playerPos = useRef(
    new THREE.Vector3(
      spawnXZ[0],
      terrainHeight(spawnXZ[0], spawnXZ[1]),
      spawnXZ[1],
    ),
  )
  const player2Pos = useRef(
    new THREE.Vector3(
      CTF_PLAYER_SPAWN_X[1],
      terrainHeight(CTF_PLAYER_SPAWN_X[1], 0),
      0,
    ),
  )
  const moveTarget = useRef(new THREE.Vector3(0, 0, 0))
  const movingRef = useRef(false)
  const p0VertVelRef = useRef(0)
  const p1VertVelRef = useRef(0)

  const moveIndicator = useRef({
    time: 0,
    pos: new THREE.Vector3(),
    rotY: 0,
  })

  const rmbHeldRef = useRef(false)
  const lastMpSendRef = useRef(0)

  const lastPointerGroundRef = useRef(new THREE.Vector3())
  const hasPointerGroundRef = useRef(false)
  const attackAimActiveRef = useRef(false)
  const aimMarkerVisibleRef = useRef(false)
  const attackMarkerRef = useRef(null)
  const aimReticleArrowRef = useRef(null)

  const recoil = useRef(0)
  const currentWeaponId = useRef(isCtfGameMode(gameMode) ? 'mg' : 'club')
  const fireReadyAtByWeapon = useRef({ mg: 0, sniper: 0, club: 0 })
  const fireCooldownStartByWeapon = useRef({ mg: 0, sniper: 0, club: 0 })

  const bullets = useRef(new Map())
  const nextBulletId = useRef(1)
  const [bulletIds, setBulletIds] = useState([])

  const enemies = useRef(new Map())
  const nextEnemyId = useRef(1)

  const ctfRef = useRef({
    flags: createCtfFlagState(),
    p0: {
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      alive: true,
      respawnUntil: 0,
      stunUntil: 0,
      team: 0,
    },
    p1: {
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      alive: true,
      respawnUntil: 0,
      stunUntil: 0,
      team: 1,
    },
    scores: [0, 0],
    p2FireReady: 0,
    winner: null,
  })

  const keysP2 = useRef(new Set())

  const oppPid = networkSlot === 1 ? 'p0' : 'p1'
  const oppPosRef = oppPid === 'p0' ? playerPos : player2Pos
  const oppStatsRef = useMemo(
    () => ({ get current() { return ctfRef.current[oppPid] } }),
    [oppPid],
  )

  const [enemyIds, setEnemyIds] = useState(() => {
    const ids = []
    if (isCtfGameMode(gameMode)) return ids
    const n = gameMode === GAME_MODE_MMO_ONLINE ? MMO_ENEMY_COUNT : ENEMY_COUNT
    for (let i = 0; i < n; i++) {
      const id = nextEnemyId.current++
      const [x, y, z] = randomEnemyPosition(pillars)
      enemies.current.set(id, {
        pos: new THREE.Vector3(x, y, z),
        hp: ENEMY_MAX_HP,
        maxHp: ENEMY_MAX_HP,
      })
      ids.push(id)
    }
    return ids
  })

  const aimArrowGeometry = useMemo(() => createAimCornerArrowGeometry(), [])
  const wc3MoveArrowGeometry = useMemo(() => createWc3MoveArrowGeometry(), [])
  const terrainGeometry = useMemo(() => createTerrainGeometry(), [])
  const aimSquareEdgesGeo = useMemo(
    () => new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.34, 0.34)),
    [],
  )

  const { camera, gl } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const pointerNdc = useMemo(() => new THREE.Vector2(), [])
  const moveDelta = useMemo(() => new THREE.Vector3(), [])

  const hpPickupIdList = useMemo(() => {
    if (isCtfGameMode(gameMode)) return []
    return Array.from({ length: WORLD_HP_PICKUP_COUNT }, (_, i) => `hpk-${i}`)
  }, [gameMode])

  const hpPickupsRef = useRef(new Map())
  const worldSurvivalHpRef = useRef({ hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP })
  const loadoutRef = useRef({
    ownedMg: false,
    ownedSniper: false,
    ammo: 0,
    mgBurstLeft: 0,
  })
  const clubSwingP0Ref = useRef(createClubSwingState())
  const clubSwingP1Ref = useRef(createClubSwingState())
  const clubMeleeQueuedP0Ref = useRef(null)
  const clubMeleeQueuedP1Ref = useRef(null)
  const recoil2Ref = useRef(0)
  const currentWeaponIdP2 = useRef('mg')
  const fireReadyAtByWeaponP2 = useRef({ mg: 0, sniper: 0, club: 0 })
  const fireCooldownStartByWeaponP2 = useRef({ mg: 0, sniper: 0, club: 0 })
  const p1ClubSwingGroupRef = useRef(null)
  const p2ClubSwingGroupRef = useRef(null)
  const p2WeaponMgRef = useRef(null)
  const p2WeaponSnRef = useRef(null)
  const p2WeaponClubRef = useRef(null)
  const nextAmmoPickupId = useRef(1)
  const cratesRef = useRef(new Map())
  const ammoPickupsRef = useRef(new Map())
  const [crateIds, setCrateIds] = useState([])
  const [ammoPickupIds, setAmmoPickupIds] = useState([])
  const p1WeaponMgRef = useRef(null)
  const p1WeaponSnRef = useRef(null)
  const p1WeaponClubRef = useRef(null)

  const ctfP0StatsRef = useMemo(
    () => ({ get current() { return ctfRef.current.p0 } }),
    [],
  )
  const ctfP1StatsRef = useMemo(
    () => ({ get current() { return ctfRef.current.p1 } }),
    [],
  )
  const worldSurvivalStatsRef = useMemo(
    () => ({ get current() { return worldSurvivalHpRef.current } }),
    [],
  )

  useEffect(() => {
    hpPickupsRef.current.clear()
    ammoPickupsRef.current.clear()
    setAmmoPickupIds([])
    cratesRef.current.clear()
    setCrateIds([])
    if (isCtfGameMode(gameMode)) {
      currentWeaponId.current = 'mg'
      currentWeaponIdP2.current = 'mg'
      p0VertVelRef.current = 0
      p1VertVelRef.current = 0
      clubSwingP0Ref.current = createClubSwingState()
      clubSwingP1Ref.current = createClubSwingState()
      clubMeleeQueuedP0Ref.current = null
      clubMeleeQueuedP1Ref.current = null
      return
    }
    loadoutRef.current = {
      ownedMg: false,
      ownedSniper: false,
      ammo: 0,
      mgBurstLeft: 0,
    }
    currentWeaponId.current = 'club'
    p0VertVelRef.current = 0
    p1VertVelRef.current = 0
    for (const id of hpPickupIdList) {
      const [x, z] = randomHpPackXZ(pillars)
      hpPickupsRef.current.set(id, { x, z, respawnUntil: 0 })
    }
    worldSurvivalHpRef.current = { hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP }
    const crateCount =
      gameMode === GAME_MODE_MMO_ONLINE ? WORLD_LOOT_CRATE_COUNT_MMO : WORLD_LOOT_CRATE_COUNT
    const cids = []
    for (let i = 0; i < crateCount; i++) {
      const cid = `crate-${i}`
      const [cx, cz] = randomHpPackXZ(pillars)
      cratesRef.current.set(cid, { x: cx, z: cz })
      cids.push(cid)
    }
    setCrateIds(cids)
  }, [gameMode, pillars, hpPickupIdList])

  useEffect(() => {
    const up = (e) => {
      if (e.button === 2) rmbHeldRef.current = false
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  useEffect(() => {
    const el = gl.domElement
    const slot = networkSlot ?? 0
    const onlineCtf = gameMode === GAME_MODE_CTF_ONLINE && networkSlot != null
    const fromP2 = onlineCtf && slot === 1

    const ndcFromEvent = (e) => {
      const r = el.getBoundingClientRect()
      pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1
      pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1
    }

    const groundPoint = (e) => {
      ndcFromEvent(e)
      raycaster.setFromCamera(pointerNdc, camera)
      const mesh = terrainMeshRef.current
      if (!mesh) return null
      const hits = raycaster.intersectObject(mesh, false)
      return hits.length ? hits[0].point.clone() : null
    }

    const trySpawnBullet = (dirX, dirZ, weaponId = null) => {
      if (isCtfGameMode(gameMode)) {
        const t0 = nowSec()
        const st = fromP2 ? ctfRef.current.p1 : ctfRef.current.p0
        if (ctfRef.current.winner !== null || !st.alive || t0 < st.stunUntil) return
      }

      const dir = new THREE.Vector3(dirX, 0, dirZ)
      if (dir.lengthSq() < 1e-8) return
      dir.normalize()

      const bodyRef = fromP2 ? player2Ref : playerRef
      if (bodyRef.current) {
        bodyRef.current.rotation.y = Math.atan2(dir.x, dir.z)
      }

      const w = weaponId ? WEAPONS[weaponId] : WEAPONS[currentWeaponId.current]
      const wid = w.id
      if (wid === 'club') return
      const worldLoot = !isCtfGameMode(gameMode) && !fromP2
      if (worldLoot) {
        if (wid === 'club') return
        const L = loadoutRef.current
        if (wid === 'mg' && !L.ownedMg) return
        if (wid === 'sniper' && !L.ownedSniper) return
        if (wid === 'mg') {
          if (L.mgBurstLeft <= 0 && L.ammo <= 0) return
        } else if (wid === 'sniper') {
          if (L.ammo <= 0) return
        }
      }

      const t = nowSec()
      if (t < fireReadyAtByWeapon.current[wid]) return

      const pos = fromP2 ? player2Pos.current : playerPos.current
      const g = terrainHeight(pos.x, pos.z)
      const origin = new THREE.Vector3(pos.x, g + 0.75, pos.z)

      if (worldLoot) {
        const L = loadoutRef.current
        if (wid === 'mg') {
          if (L.mgBurstLeft <= 0) {
            L.ammo -= 1
            L.mgBurstLeft = 3
          }
          L.mgBurstLeft -= 1
        } else if (wid === 'sniper') {
          L.ammo -= 1
        }
      }

      fireCooldownStartByWeapon.current[wid] = t
      fireReadyAtByWeapon.current[wid] = t + w.cooldown
      recoil.current = w.recoil

      const id = nextBulletId.current++
      const bulletLife = Math.max(
        12,
        (MAP_HALF * 2.6) / Math.max(3.5, w.speed),
      )
      const ctf = isCtfGameMode(gameMode)
      bullets.current.set(id, {
        pos: origin.clone().addScaledVector(dir, 0.6),
        dir: dir.clone(),
        life: bulletLife,
        damage: w.damage,
        speed: w.speed,
        color: w.bulletColor,
        emissive: w.bulletEmissive,
        emissiveIntensity: w.emissiveIntensity,
        radius: w.bulletRadius,
        weaponId: wid,
        ownerKey: ctf ? (fromP2 ? 'p1' : 'p0') : null,
        ownerTeam: ctf ? (fromP2 ? 1 : 0) : null,
      })
      setBulletIds((keys) => [...keys, id])
    }

    const onPointerMove = (e) => {
      if (e.target !== el) return
      const pt = groundPoint(e)
      if (pt) {
        lastPointerGroundRef.current.copy(pt)
        hasPointerGroundRef.current = true
      }
      if (e.buttons & 2 && rmbHeldRef.current) {
        camOrbitYawRef.current -= e.movementX * CAM_ORBIT_YAW_PER_PX
        camOrbitPitchRef.current -= e.movementY * CAM_ORBIT_PITCH_PER_PX
        camOrbitPitchRef.current = THREE.MathUtils.clamp(
          camOrbitPitchRef.current,
          CAM_ORBIT_PITCH_MIN,
          CAM_ORBIT_PITCH_MAX,
        )
        if (pt) {
          const lp = fromP2 ? player2Pos.current : playerPos.current
          const bodyRef = fromP2 ? player2Ref : playerRef
          const dx = pt.x - lp.x
          const dz = pt.z - lp.z
          if (dx * dx + dz * dz > 1e-8 && bodyRef.current) {
            bodyRef.current.rotation.y = Math.atan2(dx, dz)
          }
        }
      }
    }

    const onPointerDown = (e) => {
      if (e.target !== el) return
      const p = groundPoint(e)
      if (p) {
        lastPointerGroundRef.current.copy(p)
        hasPointerGroundRef.current = true
      }

      if (e.button === 2) {
        if (attackAimActiveRef.current && aimMarkerVisibleRef.current) {
          aimMarkerVisibleRef.current = false
          setGameCursor(CURSOR_RTS_GAUNTLET)
          return
        }

        if (!p) return
        if (onlineCtf && slot === 1) {
          rmbHeldRef.current = true
          moveTarget.current.copy(p)
          ;[moveTarget.current.x, moveTarget.current.z] = clampXZToArena(
            moveTarget.current.x,
            moveTarget.current.z,
            0.28,
          )
          moveTarget.current.y = terrainHeight(moveTarget.current.x, moveTarget.current.z)
          movingRef.current = true
          const ind = moveIndicator.current
          ind.time = 0.95
          ind.pos.copy(moveTarget.current)
          ind.pos.y += 0.04
          const p2 = player2Pos.current
          ind.rotY = Math.atan2(ind.pos.x - p2.x, ind.pos.z - p2.z)
        } else if (!onlineCtf || slot === 0) {
          rmbHeldRef.current = true
          moveTarget.current.copy(p)
          ;[moveTarget.current.x, moveTarget.current.z] = clampXZToArena(
            moveTarget.current.x,
            moveTarget.current.z,
            0.28,
          )
          moveTarget.current.y = terrainHeight(moveTarget.current.x, moveTarget.current.z)
          movingRef.current = true
          const ind = moveIndicator.current
          ind.time = 0.95
          ind.pos.copy(moveTarget.current)
          ind.pos.y += 0.04
          ind.rotY = Math.atan2(
            ind.pos.x - playerPos.current.x,
            ind.pos.z - playerPos.current.z,
          )
        }
      } else if (e.button === 0) {
        if (!p) return
        const worldLoot = !isCtfGameMode(gameMode) && !fromP2
        if (worldLoot && currentWeaponId.current === 'club') {
          const pos = playerPos.current
          if (attackAimActiveRef.current) {
            if (!aimMarkerVisibleRef.current) return
            clubMeleeQueuedP0Ref.current = { aim: true, tx: p.x, tz: p.z, px: pos.x, pz: pos.z }
          } else {
            const g0 = terrainHeight(pos.x, pos.z)
            const origin = new THREE.Vector3(pos.x, g0 + 0.75, pos.z)
            const dir = p.clone().sub(origin)
            dir.y = 0
            if (dir.lengthSq() > 1e-6 && playerRef.current) {
              playerRef.current.rotation.y = Math.atan2(dir.x, dir.z)
            }
            clubMeleeQueuedP0Ref.current = { aim: false }
          }
          return
        }
        if (isCtfGameMode(gameMode) && !fromP2 && currentWeaponId.current === 'club') {
          const pos = playerPos.current
          if (attackAimActiveRef.current) {
            if (!aimMarkerVisibleRef.current) return
            clubMeleeQueuedP0Ref.current = { aim: true, tx: p.x, tz: p.z, px: pos.x, pz: pos.z }
          } else {
            const g0 = terrainHeight(pos.x, pos.z)
            const origin = new THREE.Vector3(pos.x, g0 + 0.75, pos.z)
            const dir = p.clone().sub(origin)
            dir.y = 0
            if (dir.lengthSq() > 1e-6 && playerRef.current) {
              playerRef.current.rotation.y = Math.atan2(dir.x, dir.z)
            }
            clubMeleeQueuedP0Ref.current = { aim: false }
          }
          return
        }
        if (isCtfGameMode(gameMode) && fromP2 && currentWeaponId.current === 'club') {
          const pos = player2Pos.current
          if (attackAimActiveRef.current) {
            if (!aimMarkerVisibleRef.current) return
            clubMeleeQueuedP1Ref.current = { aim: true, tx: p.x, tz: p.z, px: pos.x, pz: pos.z }
          } else {
            const g0 = terrainHeight(pos.x, pos.z)
            const origin = new THREE.Vector3(pos.x, g0 + 0.75, pos.z)
            const dir = p.clone().sub(origin)
            dir.y = 0
            if (dir.lengthSq() > 1e-6 && player2Ref.current) {
              player2Ref.current.rotation.y = Math.atan2(dir.x, dir.z)
            }
            clubMeleeQueuedP1Ref.current = { aim: false }
          }
          return
        }
        if (attackAimActiveRef.current) {
          if (!aimMarkerVisibleRef.current) return
          const pos = fromP2 ? player2Pos.current : playerPos.current
          trySpawnBullet(p.x - pos.x, p.z - pos.z)
          return
        }
        const pos = fromP2 ? player2Pos.current : playerPos.current
        const g = terrainHeight(pos.x, pos.z)
        const origin = new THREE.Vector3(pos.x, g + 0.75, pos.z)
        const dir = p.clone().sub(origin)
        dir.y = 0
        if (dir.lengthSq() < 1e-6) return
        trySpawnBullet(dir.x, dir.z)
      }
    }

    const onContextMenu = (e) => {
      e.preventDefault()
    }

    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('contextmenu', onContextMenu)
    return () => {
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('contextmenu', onContextMenu)
    }
  }, [camera, gl, raycaster, pointerNdc, setGameCursor, gameMode, networkSlot])

  useEffect(() => {
    const syncAimCursor = () => {
      setGameCursor(
        attackAimActiveRef.current && aimMarkerVisibleRef.current
          ? 'none'
          : CURSOR_RTS_GAUNTLET,
      )
    }
    const onKeyDown = (e) => {
      if (e.repeat) return
      if (e.code === 'Space') {
        e.preventDefault()
        const onlineCtf = gameMode === GAME_MODE_CTF_ONLINE && networkSlot != null
        const slot = networkSlot ?? 0
        if (!isCtfGameMode(gameMode)) {
          tryJumpFromGround(playerPos, p0VertVelRef)
        } else if (onlineCtf && slot === 1) {
          tryJumpFromGround(player2Pos, p1VertVelRef)
        } else {
          tryJumpFromGround(playerPos, p0VertVelRef)
        }
        return
      }
      if (gameMode === GAME_MODE_CTF && e.code === 'Numpad0') {
        e.preventDefault()
        tryJumpFromGround(player2Pos, p1VertVelRef)
        return
      }
      if (e.code === 'KeyA') {
        e.preventDefault()
        if (!attackAimActiveRef.current) {
          attackAimActiveRef.current = true
          aimMarkerVisibleRef.current = true
          syncAimCursor()
          return
        }
        if (!aimMarkerVisibleRef.current) {
          aimMarkerVisibleRef.current = true
          syncAimCursor()
          return
        }
        attackAimActiveRef.current = false
        aimMarkerVisibleRef.current = false
        setGameCursor(CURSOR_RTS_GAUNTLET)
        return
      }
      let next = null
      if (isCtfGameMode(gameMode)) {
        if (gameMode === GAME_MODE_CTF) {
          if (e.code === 'Numpad1') {
            currentWeaponIdP2.current = 'mg'
            return
          }
          if (e.code === 'Numpad2') {
            currentWeaponIdP2.current = 'sniper'
            return
          }
          if (e.code === 'Numpad3') {
            currentWeaponIdP2.current = 'club'
            return
          }
        }
        if (e.code === 'Digit1' || e.code === 'Numpad1') next = 'mg'
        if (e.code === 'Digit2' || e.code === 'Numpad2') next = 'sniper'
        if (e.code === 'Digit3' || e.code === 'Numpad3') next = 'club'
      } else {
        if (e.code === 'Digit3' || e.code === 'Numpad3') next = 'club'
        if ((e.code === 'Digit1' || e.code === 'Numpad1') && loadoutRef.current.ownedMg) next = 'mg'
        if ((e.code === 'Digit2' || e.code === 'Numpad2') && loadoutRef.current.ownedSniper)
          next = 'sniper'
      }
      if (!next || next === currentWeaponId.current) return
      currentWeaponId.current = next
    }
    window.addEventListener('keydown', onKeyDown)
    setGameCursor(CURSOR_RTS_GAUNTLET)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      setGameCursor(CURSOR_RTS_GAUNTLET)
    }
  }, [setGameCursor, gameMode, networkSlot])

  useEffect(() => {
    const el = gl.domElement
    const onWheel = (e) => {
      if (e.target !== el) return
      e.preventDefault()
      const zoomOut = e.deltaY > 0
      const f = zoomOut ? CAM_ZOOM_PER_NOTCH : 1 / CAM_ZOOM_PER_NOTCH
      camZoomTarget.current = THREE.MathUtils.clamp(
        camZoomTarget.current * f,
        CAM_ZOOM_MIN,
        CAM_ZOOM_MAX,
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [gl])

  useEffect(() => {
    if (!isCtfGameMode(gameMode)) return
    const down = (e) => {
      if (e.repeat) return
      keysP2.current.add(e.code)
    }
    const up = (e) => {
      keysP2.current.delete(e.code)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [gameMode])

  useFrame((_, delta) => {
    const p = playerPos.current
    const p2 = player2Pos.current
    const t = moveTarget.current
    const tNow = nowSec()
    const ctf = ctfRef.current
    const slot = networkSlot ?? 0
    const onlineCtf =
      gameMode === GAME_MODE_CTF_ONLINE && networkSlot != null && mpBridgeRef?.current
    const onlineMmo =
      gameMode === GAME_MODE_MMO_ONLINE && networkSlot != null && mpBridgeRef?.current
    const online = onlineCtf || onlineMmo

    if (hitFeedbackRef?.current) {
      const fx = hitFeedbackRef.current
      fx.vignette *= Math.exp(-4.6 * delta)
      fx.shake *= Math.exp(-16 * delta)
      fx.flash *= Math.exp(-22 * delta)
    }

    const worldSurvival = !isCtfGameMode(gameMode)
    if (worldSurvival) {
      const wh = worldSurvivalHpRef.current
      wh.hp -= WORLD_HP_DRAIN_PER_SEC * delta
      if (wh.hp <= 0) {
        wh.hp = wh.maxHp
        const [rx, rz] = randomOpenWorldSpawnXZ(pillars)
        p.x = rx
        p.z = rz
        ;[p.x, p.z] = resolveBodyInArena(p.x, p.z, PLAYER_R, pillars)
        p.y = terrainHeight(p.x, p.z)
        p0VertVelRef.current = 0
        if (playerRef.current) playerRef.current.position.set(p.x, p.y, p.z)
        movingRef.current = false
      }
      hpPickupsRef.current.forEach((pk) => {
        if (tNow < pk.respawnUntil) return
        const dx = p.x - pk.x
        const dz = p.z - pk.z
        if (dx * dx + dz * dz <= WORLD_HP_PICKUP_RADIUS * WORLD_HP_PICKUP_RADIUS) {
          wh.hp = Math.min(wh.maxHp, wh.hp + WORLD_HP_PICKUP_HEAL)
          const span = WORLD_HP_PICKUP_RESPAWN_SEC_MAX - WORLD_HP_PICKUP_RESPAWN_SEC_MIN
          pk.respawnUntil = tNow + WORLD_HP_PICKUP_RESPAWN_SEC_MIN + Math.random() * span
          const [nx, nz] = randomHpPackXZ(pillars)
          pk.x = nx
          pk.z = nz
        }
      })
      const ammoTaken = []
      ammoPickupsRef.current.forEach((pk, aid) => {
        if (tNow < pk.respawnUntil) return
        const dx = p.x - pk.x
        const dz = p.z - pk.z
        if (dx * dx + dz * dz <= AMMO_PICKUP_RADIUS * AMMO_PICKUP_RADIUS) {
          loadoutRef.current.ammo += pk.amount ?? AMMO_DROP_ENEMY_AMOUNT
          ammoTaken.push(aid)
        }
      })
      ammoTaken.forEach((aid) => ammoPickupsRef.current.delete(aid))
      if (ammoTaken.length) {
        setAmmoPickupIds((keys) => keys.filter((k) => !ammoTaken.includes(k)))
      }

      const pBumpY = p.y + 0.7
      const bumpedCrateIds = []
      cratesRef.current.forEach((cr, cid) => {
        const cty = terrainHeight(cr.x, cr.z) + CRATE_HALF.y
        if (
          sphereIntersectsBox(
            p.x,
            pBumpY,
            p.z,
            cr.x,
            cty,
            cr.z,
            CRATE_HALF.x,
            CRATE_HALF.y,
            CRATE_HALF.z,
            PLAYER_R + 0.08,
          )
        ) {
          bumpedCrateIds.push(cid)
        }
      })
      if (bumpedCrateIds.length) {
        for (const cid of bumpedCrateIds) {
          if (!cratesRef.current.has(cid)) continue
          grantWorldCrateLoot(loadoutRef, currentWeaponId)
          cratesRef.current.delete(cid)
        }
        setCrateIds((keys) => keys.filter((k) => !bumpedCrateIds.includes(k)))
      }

      const { worldHp: whEl, worldHpBar: wbEl } = hudRefs?.current ?? {}
      if (whEl) {
        whEl.textContent = `생존 HP ${Math.max(0, Math.ceil(wh.hp))} / ${wh.maxHp} · −${WORLD_HP_DRAIN_PER_SEC}/초 · 팩 +${WORLD_HP_PICKUP_HEAL} · 처치 +${ENEMY_KILL_HEAL}`
      }
      if (wbEl) {
        const ratio = Math.max(0, wh.hp / wh.maxHp)
        wbEl.style.width = `${(ratio * 100).toFixed(1)}%`
        wbEl.style.background =
          ratio < 0.28
            ? 'linear-gradient(90deg,#ff8a80,#e53935)'
            : 'linear-gradient(90deg,#69f0ae,#00c853)'
      }
    }

    const tryStartClubSwing = (qRef, swingRef, readyRef, startRef, who) => {
      const q = qRef.current
      if (!q || swingRef.current.active) return
      if (tNow < readyRef.current.club) return
      let fx
      let fz
      let px
      let pz
      if (q.aim) {
        fx = q.tx - q.px
        fz = q.tz - q.pz
        px = q.px
        pz = q.pz
      } else {
        const bodyRef = who === 'p0' ? playerRef : player2Ref
        const pos = who === 'p0' ? p : p2
        const yaw = bodyRef.current?.rotation.y ?? 0
        fx = Math.sin(yaw)
        fz = Math.cos(yaw)
        px = pos.x
        pz = pos.z
      }
      const len = Math.hypot(fx, fz)
      if (len < 1e-6) return
      fx /= len
      fz /= len
      qRef.current = null
      readyRef.current.club = tNow + WEAPONS.club.cooldown
      startRef.current.club = tNow
      const sw = swingRef.current
      sw.active = true
      sw.elapsed = 0
      sw.hitApplied = false
      sw.fx = fx
      sw.fz = fz
      sw.px = px
      sw.pz = pz
      if (who === 'p0') recoil.current = WEAPONS.club.recoil
      else recoil2Ref.current = WEAPONS.club.recoil
    }

    tryStartClubSwing(
      clubMeleeQueuedP0Ref,
      clubSwingP0Ref,
      fireReadyAtByWeapon,
      fireCooldownStartByWeapon,
      'p0',
    )
    tryStartClubSwing(
      clubMeleeQueuedP1Ref,
      clubSwingP1Ref,
      fireReadyAtByWeaponP2,
      fireCooldownStartByWeaponP2,
      'p1',
    )

    const applyClubHitForSwing = (swingRef, who) => {
      const s = swingRef.current
      if (s.hitApplied || !s.active) return
      s.hitApplied = true
      const { fx, fz, px, pz } = s

      if (worldSurvival && who === 'p0') {
        const clubDeadEnemies = []
        enemies.current.forEach((en, eid) => {
          const ex = en.pos.x - p.x
          const ez = en.pos.z - p.z
          const dist = Math.hypot(ex, ez)
          if (dist > CLUB_MELEE_RANGE || dist < 1e-5) return
          const dot = (ex / dist) * fx + (ez / dist) * fz
          if (dot < CLUB_MELEE_COS) return
          en.hp -= CLUB_MELEE_DAMAGE
          if (en.hp <= 0) {
            clubDeadEnemies.push({ eid, x: en.pos.x, z: en.pos.z })
            enemies.current.delete(eid)
          }
        })
        if (clubDeadEnemies.length) {
          const whk = worldSurvivalHpRef.current
          whk.hp = Math.min(whk.maxHp, whk.hp + ENEMY_KILL_HEAL * clubDeadEnemies.length)
          setEnemyIds((keys) => keys.filter((k) => !clubDeadEnemies.some((d) => d.eid === k)))
          const addIds = []
          for (const d of clubDeadEnemies) {
            const aid = `ap-${nextAmmoPickupId.current++}`
            ammoPickupsRef.current.set(aid, {
              x: d.x,
              z: d.z,
              amount: AMMO_DROP_ENEMY_AMOUNT,
              respawnUntil: 0,
            })
            addIds.push(aid)
          }
          setAmmoPickupIds((prev) => [...prev, ...addIds])
        }

        if (
          gameMode === GAME_MODE_MMO_ONLINE &&
          networkSlot != null &&
          mpBridgeRef?.current &&
          remoteMmoPeersRef?.current
        ) {
          const slotN = networkSlot
          remoteMmoPeersRef.current.forEach((pose, sl) => {
            if (sl === slotN || !pose || typeof pose.x !== 'number') return
            const vy = typeof pose.y === 'number' ? pose.y : terrainHeight(pose.x, pose.z)
            const ex = pose.x - px
            const ez = pose.z - pz
            const dist = Math.hypot(ex, ez)
            if (dist > CLUB_MELEE_RANGE || dist < 1e-5) return
            const dot = (ex / dist) * fx + (ez / dist) * fz
            if (dot < CLUB_MELEE_COS) return
            const aEy = terrainHeight(px, pz) + 0.75
            const vEy = vy + 0.75
            if (Math.abs(aEy - vEy) > 1.45) return
            mpBridgeRef.current.send({
              kind: 'mmo_hit',
              victimSlot: sl,
              dmg: CLUB_MELEE_DAMAGE,
              sniper: false,
              club: true,
            })
          })
        }
      }

      if (isCtfGameMode(gameMode)) {
        const isOnlineHit =
          gameMode === GAME_MODE_CTF_ONLINE && networkSlot != null && mpBridgeRef?.current
        const slotN = networkSlot ?? 0
        const tryClubHitCtf = (vslot, st, vx, vz, vy, vpid) => {
          if (!st.alive || tNow < st.stunUntil) return
          const ex = vx - px
          const ez = vz - pz
          const dist = Math.hypot(ex, ez)
          if (dist > CLUB_MELEE_RANGE || dist < 1e-5) return
          const dot = (ex / dist) * fx + (ez / dist) * fz
          if (dot < CLUB_MELEE_COS) return
          const aEy = terrainHeight(px, pz) + 0.75
          const vEy = vy + 0.75
          if (Math.abs(aEy - vEy) > 1.45) return
          const atkSlot = who === 'p0' ? 0 : 1
          if (isOnlineHit) {
            if (atkSlot !== slotN || vslot === slotN) return
            mpBridgeRef.current.send({
              kind: 'hit',
              victimSlot: vslot,
              dmg: CLUB_MELEE_DAMAGE,
              sniper: false,
              club: true,
            })
            return
          }
          st.hp -= CLUB_MELEE_DAMAGE
          bumpPlayerHitFx(hitFeedbackRef, false)
          if (st.hp <= 0) {
            dropCtfFlagsFromCarrier(ctf, vpid, vx, vy, vz)
            st.alive = false
            st.respawnUntil = tNow + CTF_RESPAWN_DELAY
            st.hp = 0
          }
        }

        if (who === 'p0') {
          tryClubHitCtf(1, ctf.p1, p2.x, p2.z, p2.y, 'p1')
        } else {
          tryClubHitCtf(0, ctf.p0, p.x, p.z, p.y, 'p0')
        }
      }
    }

    const stepClubSwing = (swingRef, groupRef, who) => {
      const s = swingRef.current
      if (!s.active) {
        applyClubSwingVisual(groupRef, CLUB_SWING_DURATION)
        return
      }
      s.elapsed += delta
      applyClubSwingVisual(groupRef, s.elapsed)
      if (!s.hitApplied && s.elapsed >= CLUB_HIT_T0) {
        applyClubHitForSwing(swingRef, who)
      }
      if (s.elapsed >= CLUB_SWING_DURATION) {
        s.active = false
        s.elapsed = 0
        s.hitApplied = false
        applyClubSwingVisual(groupRef, CLUB_SWING_DURATION)
      }
    }

    stepClubSwing(clubSwingP0Ref, p1ClubSwingGroupRef, 'p0')
    stepClubSwing(clubSwingP1Ref, p2ClubSwingGroupRef, 'p1')

    if (onlineCtf && pendingHitRef?.current) {
      const ph = pendingHitRef.current
      if (ph.victimSlot === slot) {
        const st = slot === 0 ? ctf.p0 : ctf.p1
        const vpos = slot === 0 ? p : p2
        st.hp -= ph.dmg ?? 10
        bumpPlayerHitFx(hitFeedbackRef, !!ph.sniper)
        if (ph.sniper) {
          dropCtfFlagsFromCarrier(ctf, slot === 0 ? 'p0' : 'p1', vpos.x, vpos.y, vpos.z)
          st.stunUntil = Math.max(st.stunUntil, tNow + CTF_STUN_DURATION)
        }
        if (st.hp <= 0) {
          dropCtfFlagsFromCarrier(ctf, slot === 0 ? 'p0' : 'p1', vpos.x, vpos.y, vpos.z)
          st.alive = false
          st.respawnUntil = tNow + CTF_RESPAWN_DELAY
          st.hp = 0
        }
      }
      pendingHitRef.current = null
    }

    if (onlineMmo && pendingMmoHitRef?.current) {
      const mh = pendingMmoHitRef.current
      if (mh.victimSlot === slot && worldSurvival) {
        const wh = worldSurvivalHpRef.current
        wh.hp -= mh.dmg ?? 10
        bumpPlayerHitFx(hitFeedbackRef, !!mh.sniper)
        if (wh.hp <= 0) {
          wh.hp = wh.maxHp
          const [rx, rz] = randomOpenWorldSpawnXZ(pillars)
          p.x = rx
          p.z = rz
          ;[p.x, p.z] = resolveBodyInArena(p.x, p.z, PLAYER_R, pillars)
          p.y = terrainHeight(p.x, p.z)
          p0VertVelRef.current = 0
          if (playerRef.current) playerRef.current.position.set(p.x, p.y, p.z)
          movingRef.current = false
        }
      }
      pendingMmoHitRef.current = null
    }

    const buf = remoteBufferRef?.current
    const mpLerp = 0.26
    if (onlineCtf && buf && isCtfGameMode(gameMode)) {
      if (slot === 0 && buf.p1) {
        const r = buf.p1
        p2.x += (r.x - p2.x) * mpLerp
        p2.z += (r.z - p2.z) * mpLerp
        if (typeof r.y === 'number' && Number.isFinite(r.y)) {
          p2.y += (r.y - p2.y) * mpLerp
        } else {
          p2.y = terrainHeight(p2.x, p2.z)
        }
        if (player2Ref.current && r.ry != null) {
          let dy = r.ry - player2Ref.current.rotation.y
          while (dy > Math.PI) dy -= Math.PI * 2
          while (dy < -Math.PI) dy += Math.PI * 2
          player2Ref.current.rotation.y += dy * mpLerp
        }
        ctf.p1.hp = r.hp
        ctf.p1.alive = r.alive
        ;[p2.x, p2.z] = resolveBodyInArena(p2.x, p2.z, PLAYER_R, pillars)
        {
          const tg = terrainHeight(p2.x, p2.z)
          if (p2.y < tg) p2.y = tg
        }
        if (player2Ref.current) {
          player2Ref.current.position.set(p2.x, p2.y, p2.z)
        }
      }
      if (slot === 1 && buf.p0) {
        const r = buf.p0
        p.x += (r.x - p.x) * mpLerp
        p.z += (r.z - p.z) * mpLerp
        if (typeof r.y === 'number' && Number.isFinite(r.y)) {
          p.y += (r.y - p.y) * mpLerp
        } else {
          p.y = terrainHeight(p.x, p.z)
        }
        if (playerRef.current && r.ry != null) {
          let dy = r.ry - playerRef.current.rotation.y
          while (dy > Math.PI) dy -= Math.PI * 2
          while (dy < -Math.PI) dy += Math.PI * 2
          playerRef.current.rotation.y += dy * mpLerp
        }
        ctf.p0.hp = r.hp
        ctf.p0.alive = r.alive
        ;[p.x, p.z] = resolveBodyInArena(p.x, p.z, PLAYER_R, pillars)
        {
          const tg = terrainHeight(p.x, p.z)
          if (p.y < tg) p.y = tg
        }
        if (playerRef.current) {
          playerRef.current.position.set(p.x, p.y, p.z)
        }
      }
      if (slot === 1 && buf.ctf) {
        const c = buf.ctf
        applyCtfFromNet(ctf, c.flags)
        if (Array.isArray(c.scores) && c.scores.length >= 2) {
          ctf.scores[0] = c.scores[0]
          ctf.scores[1] = c.scores[1]
        }
        if (c.winner !== undefined) ctf.winner = c.winner
      }
    }

    if (isCtfGameMode(gameMode)) {
      const p0s = ctf.p0
      const p1s = ctf.p1

      if (!online || slot === 0) {
        if (!p0s.alive && tNow >= p0s.respawnUntil) {
          p0s.alive = true
          p0s.hp = p0s.maxHp
          p0s.stunUntil = 0
          p.x = CTF_PLAYER_SPAWN_X[0]
          p.z = 0
          ;[p.x, p.z] = resolveBodyInArena(p.x, p.z, PLAYER_R, pillars)
          p.y = terrainHeight(p.x, p.z)
          p0VertVelRef.current = 0
          movingRef.current = false
        }
      }

      if (!online || slot === 1) {
        if (!p1s.alive && tNow >= p1s.respawnUntil) {
          p1s.alive = true
          p1s.hp = p1s.maxHp
          p1s.stunUntil = 0
          p2.x = CTF_PLAYER_SPAWN_X[1]
          p2.z = 0
          ;[p2.x, p2.z] = resolveBodyInArena(p2.x, p2.z, PLAYER_R, pillars)
          p2.y = terrainHeight(p2.x, p2.z)
          p1VertVelRef.current = 0
        }
      }

      if (!online || slot === 1) {
        const k = keysP2.current
        let mx = 0
        let mz = 0
        if (k.has('KeyI')) mz += 1
        if (k.has('KeyK')) mz -= 1
        if (k.has('KeyJ')) mx -= 1
        if (k.has('KeyL')) mx += 1
        const p1CanMove = p1s.alive && tNow >= p1s.stunUntil
        const p1Carry = ctfPlayerCarryingFlag(ctf, 'p1')
        const p1SpeedMul = p1Carry ? FLAG_CARRY_SPEED_MULT : 1
        if (p1CanMove && (mx !== 0 || mz !== 0)) {
          const len = Math.hypot(mx, mz)
          const step = (P2_MOVE_SPEED * delta * p1SpeedMul) / len
          p2.x += mx * step
          p2.z += mz * step
          if (player2Ref.current) {
            player2Ref.current.rotation.y = Math.atan2(mx, mz)
          }
        }
        ;[p2.x, p2.z] = resolveBodyInArena(p2.x, p2.z, PLAYER_R, pillars)

        if (ctf.winner === null && p1CanMove && k.has('KeyF')) {
          const w2id = currentWeaponIdP2.current
          if (w2id === 'club') {
            clubMeleeQueuedP1Ref.current = { aim: false }
          } else if (tNow >= fireReadyAtByWeaponP2.current[w2id]) {
            const w = WEAPONS[w2id]
            fireCooldownStartByWeaponP2.current[w2id] = tNow
            fireReadyAtByWeaponP2.current[w2id] = tNow + w.cooldown
            recoil2Ref.current = w.recoil
            const yaw = player2Ref.current ? player2Ref.current.rotation.y : 0
            const dirX = Math.sin(yaw)
            const dirZ = Math.cos(yaw)
            const dir = new THREE.Vector3(dirX, 0, dirZ)
            if (dir.lengthSq() > 1e-8) {
              dir.normalize()
              const g2 = terrainHeight(p2.x, p2.z)
              const origin = new THREE.Vector3(p2.x, g2 + 0.75, p2.z)
              const id = nextBulletId.current++
              const bulletLife = Math.max(12, (MAP_HALF * 2.6) / Math.max(3.5, w.speed))
              bullets.current.set(id, {
                pos: origin.clone().addScaledVector(dir, 0.6),
                dir: dir.clone(),
                life: bulletLife,
                damage: w.damage,
                speed: w.speed,
                color: w.bulletColor,
                emissive: w.bulletEmissive,
                emissiveIntensity: w.emissiveIntensity,
                radius: w.bulletRadius,
                weaponId: w2id,
                ownerKey: 'p1',
                ownerTeam: 1,
              })
              setBulletIds((keys) => [...keys, id])
            }
          }
        }
      } else if (online && slot === 0) {
        ;[p2.x, p2.z] = resolveBodyInArena(p2.x, p2.z, PLAYER_R, pillars)
        {
          const tg = terrainHeight(p2.x, p2.z)
          if (p2.y < tg) p2.y = tg
        }
        if (player2Ref.current) {
          player2Ref.current.position.set(p2.x, p2.y, p2.z)
        }
      }

      const carrierOf = (pid) =>
        [0, 1].find((tid) => ctf.flags[tid].mode === 'carried' && ctf.flags[tid].carrierKey === pid)

      const tryPickup = (pid, pos, team) => {
        for (const fid of [0, 1]) {
          const f = ctf.flags[fid]
          if (f.mode === 'ground') {
            const d = distXZSq(pos.x, pos.z, f.ground.x, f.ground.z)
            if (d > CTF_FLAG_GRAB_R * CTF_FLAG_GRAB_R) continue
            if (team === fid) {
              f.mode = 'base'
              f.carrierKey = null
            } else {
              const cur = carrierOf(pid)
              if (cur !== undefined) continue
              f.mode = 'carried'
              f.carrierKey = pid
            }
            return
          }
        }
        for (const fid of [0, 1]) {
          const f = ctf.flags[fid]
          if (f.mode !== 'base' || team === fid) continue
          const [fx, fz] = ctfFlagWorldXZ(fid)
          const d = distXZSq(pos.x, pos.z, fx, fz)
          if (d > CTF_FLAG_GRAB_R * CTF_FLAG_GRAB_R) continue
          const cur = carrierOf(pid)
          if (cur !== undefined) continue
          f.mode = 'carried'
          f.carrierKey = pid
          return
        }
      }

      if (!online || slot === 0) {
        if (ctf.winner === null) {
          if (p0s.alive && tNow >= p0s.stunUntil) tryPickup('p0', p, 0)
          if (p1s.alive && tNow >= p1s.stunUntil) tryPickup('p1', p2, 1)

          const tryScore = (pid, pos, team) => {
            if (!playerInOwnBase(team, pos.x, pos.z)) return
            const enemyF = 1 - team
            const fe = ctf.flags[enemyF]
            const fo = ctf.flags[team]
            if (fe.mode !== 'carried' || fe.carrierKey !== pid) return
            if (fo.mode !== 'base') return
            ctf.scores[team] += 1
            fe.mode = 'base'
            fe.carrierKey = null
            if (ctf.scores[team] >= CTF_SCORE_TO_WIN) ctf.winner = team
          }
          if (p0s.alive) tryScore('p0', p, 0)
          if (p1s.alive) tryScore('p1', p2, 1)
        }
      }

      const { ctfScore, ctfHint } = hudRefs?.current ?? {}
      if (ctfScore) {
        ctfScore.textContent = `파랑 ${ctf.scores[0]}  ·  주황 ${ctf.scores[1]}`
      }
      if (ctfHint) {
        if (ctf.winner !== null) {
          ctfHint.textContent =
            ctf.winner === 0 ? '파랑 팀 승리!' : '주황 팀 승리!'
        } else {
          ctfHint.textContent =
            '깃발: 우리 깃발이 기지에 있을 때만 적 깃발로 득점 · 드랍: 사망·스나이퍼 스턴 · 아군 깃발 바닥=즉시 복귀 · 깃발 들면 이동 20%↓' +
            (gameMode === GAME_MODE_CTF
              ? ' · 스페이스 점프 · 주황: 패드0 점프 · 패드1·2·3 무기, F공격 · 몽둥이(패드3) 근접'
              : ' · 스페이스 점프 · 1·2·3 무기 · 몽둥이(3) 근접')
        }
      }
    }

    const p0CanAct =
      !isCtfGameMode(gameMode) ||
      (ctf.p0.alive && tNow >= ctf.p0.stunUntil && tNow >= ctf.p0.respawnUntil)

    const p1CanMove =
      isCtfGameMode(gameMode) && ctf.p1.alive && tNow >= ctf.p1.stunUntil

    const p0Carry =
      isCtfGameMode(gameMode) && ctfPlayerCarryingFlag(ctf, 'p0')
    const p0SpeedMul = p0Carry ? FLAG_CARRY_SPEED_MULT : 1
    const p1Carry = isCtfGameMode(gameMode) && ctfPlayerCarryingFlag(ctf, 'p1')
    const p1SpeedMul = p1Carry ? FLAG_CARRY_SPEED_MULT : 1

    if (movingRef.current && (!onlineCtf || slot === 0) && p0CanAct) {
      moveDelta.set(t.x - p.x, 0, t.z - p.z)
      const dist = moveDelta.length()
      if (dist < 0.08) {
        movingRef.current = false
      } else {
        const step = Math.min(P1_MOVE_SPEED * p0SpeedMul * delta, dist)
        moveDelta.normalize().multiplyScalar(step)
        p.x += moveDelta.x
        p.z += moveDelta.z

        if (!rmbHeldRef.current && playerRef.current) {
          playerRef.current.rotation.y = Math.atan2(moveDelta.x, moveDelta.z)
        }
      }
    }

    if (movingRef.current && onlineCtf && slot === 1 && p1CanMove) {
      moveDelta.set(t.x - p2.x, 0, t.z - p2.z)
      const dist = moveDelta.length()
      if (dist < 0.08) {
        movingRef.current = false
      } else {
        const step = Math.min(P2_MOVE_SPEED * p1SpeedMul * delta, dist)
        moveDelta.normalize().multiplyScalar(step)
        p2.x += moveDelta.x
        p2.z += moveDelta.z

        if (!rmbHeldRef.current && player2Ref.current) {
          player2Ref.current.rotation.y = Math.atan2(moveDelta.x, moveDelta.z)
        }
      }
    }

    ;[p.x, p.z] = resolveBodyInArena(p.x, p.z, PLAYER_R, pillars)
    const p0JumpLocal = !isCtfGameMode(gameMode) || !onlineCtf || slot === 0
    if (p0JumpLocal) {
      integratePlayerVertical(p, p0VertVelRef, delta)
    } else {
      const tg0 = terrainHeight(p.x, p.z)
      if (p.y < tg0) p.y = tg0
    }
    if (playerRef.current) {
      playerRef.current.position.set(p.x, p.y, p.z)
    }

    if (isCtfGameMode(gameMode)) {
      ;[p2.x, p2.z] = resolveBodyInArena(p2.x, p2.z, PLAYER_R, pillars)
      const p1JumpLocal = !onlineCtf || slot === 1
      if (p1JumpLocal) {
        integratePlayerVertical(p2, p1VertVelRef, delta)
      } else {
        const tg1 = terrainHeight(p2.x, p2.z)
        if (p2.y < tg1) p2.y = tg1
      }
      if (player2Ref.current) {
        player2Ref.current.position.set(p2.x, p2.y, p2.z)
      }
    }

    if (gameMode === GAME_MODE_CTF_ONLINE && slot === 1) {
      playerEyeWorld.current.set(p2.x, p2.y + PLAYER_EYE_LIFT, p2.z)
    } else {
      playerEyeWorld.current.set(p.x, p.y + PLAYER_EYE_LIFT, p.z)
    }
    const tu = terrainUniformsRef.current
    if (tu && tu.uEyePos) {
      tu.uEyePos.value.copy(playerEyeWorld.current)
    }

    const ind = moveIndicator.current
    ind.time -= delta
    if (moveArrowRef.current && moveArrowMatRef.current) {
      if (ind.time > 0) {
        const e = playerEyeWorld.current
        const mx = ind.pos.x - e.x
        const mz = ind.pos.z - e.z
        const arrSeen =
          mx * mx + mz * mz <= SIGHT_RADIUS * SIGHT_RADIUS &&
          terrainLineOfSight(e.x, e.y, e.z, ind.pos.x, ind.pos.y, ind.pos.z)
        moveArrowRef.current.visible = arrSeen
        moveArrowRef.current.position.set(ind.pos.x, ind.pos.y, ind.pos.z)
        moveArrowRef.current.rotation.y = ind.rotY + Math.PI
        const fade = Math.min(1, ind.time / 0.35)
        const op = 0.2 + 0.8 * fade
        moveArrowMatRef.current.opacity = op
        if (moveArrowRingMatRef.current) moveArrowRingMatRef.current.opacity = op * 0.72
      } else {
        moveArrowRef.current.visible = false
      }
    }

    if (gunPivotRef.current) {
      const r = recoil.current
      recoil.current = Math.max(0, r - delta * 9)
      const kick = r * r
      gunPivotRef.current.rotation.x = kick * 0.85
      gunPivotRef.current.position.z = kick * 0.12
      gunPivotRef.current.rotation.z = 0
    }

    if (gunPivot2Ref.current) {
      const r2 = recoil2Ref.current
      recoil2Ref.current = Math.max(0, r2 - delta * 9)
      const k2 = r2 * r2
      gunPivot2Ref.current.rotation.x = k2 * 0.85
      gunPivot2Ref.current.position.z = k2 * 0.12
      gunPivot2Ref.current.rotation.z = 0
    }

    const wmg = p1WeaponMgRef.current
    const wsn = p1WeaponSnRef.current
    const wcb = p1WeaponClubRef.current
    if (wmg && wsn && wcb) {
      const wv = currentWeaponId.current
      if (isCtfGameMode(gameMode)) {
        wcb.visible = wv === 'club'
        wmg.visible = wv === 'mg'
        wsn.visible = wv === 'sniper'
      } else {
        wcb.visible = wv === 'club'
        wmg.visible = wv === 'mg'
        wsn.visible = wv === 'sniper'
      }
    }

    const w2mg = p2WeaponMgRef.current
    const w2sn = p2WeaponSnRef.current
    const w2cb = p2WeaponClubRef.current
    if (w2mg && w2sn && w2cb && isCtfGameMode(gameMode)) {
      const wv2 = currentWeaponIdP2.current
      w2cb.visible = wv2 === 'club'
      w2mg.visible = wv2 === 'mg'
      w2sn.visible = wv2 === 'sniper'
    }

    const aimAx = onlineCtf && slot === 1 ? p2 : p
    const aimBodyRef = onlineCtf && slot === 1 ? player2Ref : playerRef
    if (
      attackAimActiveRef.current &&
      aimMarkerVisibleRef.current &&
      hasPointerGroundRef.current &&
      aimBodyRef.current
    ) {
      const m = lastPointerGroundRef.current
      const dx = m.x - aimAx.x
      const dz = m.z - aimAx.z
      if (dx * dx + dz * dz > 1e-6) {
        aimBodyRef.current.rotation.y = Math.atan2(dx, dz)
      }
    }

    if (attackMarkerRef.current) {
      const on =
        attackAimActiveRef.current &&
        aimMarkerVisibleRef.current &&
        hasPointerGroundRef.current
      attackMarkerRef.current.visible = !!on
      if (on) {
        const ax = lastPointerGroundRef.current.x
        const az = lastPointerGroundRef.current.z
        const [cx, cz] = clampXZToArena(ax, az, 0.2)
        const cy = terrainHeight(cx, cz)
        attackMarkerRef.current.position.set(cx, cy + 0.07, cz)
        if (aimReticleArrowRef.current) {
          const dx = cx - aimAx.x
          const dz = cz - aimAx.z
          aimReticleArrowRef.current.rotation.y =
            dx * dx + dz * dz > 1e-8 ? Math.atan2(dx, dz) : 0
        }
      }
    }

    const w = WEAPONS[currentWeaponId.current]
    const wid = currentWeaponId.current
    const cdDur = w.cooldown
    const cdRemain = Math.max(0, fireReadyAtByWeapon.current[wid] - tNow)
    let cdProgress = 1
    if (cdRemain > 0 && cdDur > 0.0001) {
      cdProgress = Math.min(
        1,
        Math.max(0, (tNow - fireCooldownStartByWeapon.current[wid]) / cdDur),
      )
    }
    const { weapon: weaponEl, status: statusEl, bar: barEl, track: trackEl } = hudRefs?.current ?? {}
    if (weaponEl) {
      weaponEl.textContent = `${w.name}  ·  [${w.keyLabel}]`
    }
    if (statusEl) {
      if (isCtfGameMode(gameMode)) {
        statusEl.textContent =
          cdRemain > 0.02 ? `쿨타임 ${cdRemain.toFixed(2)}s` : '발사 가능'
      } else {
        const L = loadoutRef.current
        const burst = L.mgBurstLeft > 0 ? ` · 기관3발묶음 ${L.mgBurstLeft}발 남음` : ''
        const own = `${L.ownedMg ? '기관O' : '기관X'} · ${L.ownedSniper ? '스나O' : '스나X'}`
        const ammoTxt = `탄약 ${L.ammo}${burst} · ${own}`
        statusEl.textContent = cdRemain > 0.02 ? `쿨 ${cdRemain.toFixed(2)}s — ${ammoTxt}` : ammoTxt
      }
    }
    if (barEl) {
      const pct = (cdProgress * 100).toFixed(1)
      barEl.style.width = `${pct}%`
      barEl.style.background =
        cdRemain > 0.02 ? 'linear-gradient(90deg,#ffb74d,#ff9800)' : 'linear-gradient(90deg,#69f0ae,#00e676)'
    }
    if (trackEl) {
      trackEl.title = cdRemain > 0.02 ? '다음 발사까지' : '준비됨'
    }

    const agroSq = AGRO_RANGE * AGRO_RANGE
    enemies.current.forEach((en) => {
      const dx = p.x - en.pos.x
      const dz = p.z - en.pos.z
      const distSq = dx * dx + dz * dz
      if (distSq > agroSq || distSq < 1e-6) return
      const dist = Math.sqrt(distSq)
      if (dist <= STOP_DISTANCE) return
      const step = Math.min(CHASE_SPEED * delta, dist - STOP_DISTANCE)
      en.pos.x += (dx / dist) * step
      en.pos.z += (dz / dist) * step
      ;[en.pos.x, en.pos.z] = resolveBodyInArena(en.pos.x, en.pos.z, ENEMY_RADIUS_XZ, pillars)
      en.pos.y = terrainHeight(en.pos.x, en.pos.z) + ENEMY_HALF.y
    })

    const deadBullets = []
    const deadEnemyIds = []
    bullets.current.forEach((b, id) => {
      const sp = b.speed ?? 24
      b.pos.addScaledVector(b.dir, sp * delta)
      b.pos.y = terrainHeight(b.pos.x, b.pos.z) + 0.72
      b.life -= delta
      const br = b.radius ?? BULLET_RADIUS

      const outLimX = MAP_HALF_X + 0.45
      const outLimZ = MAP_HALF_Z + 0.45
      if (Math.abs(b.pos.x) > outLimX || Math.abs(b.pos.z) > outLimZ) {
        deadBullets.push(id)
        b.life = 0
        return
      }

      for (const col of pillars) {
        if (sphereIntersectsPillar(b.pos.x, b.pos.y, b.pos.z, br, col)) {
          deadBullets.push(id)
          b.life = 0
          return
        }
      }

      let hitEnemyId = null
      enemies.current.forEach((en, eid) => {
        if (hitEnemyId !== null) return
        if (
          sphereIntersectsBox(
            b.pos.x,
            b.pos.y,
            b.pos.z,
            en.pos.x,
            en.pos.y,
            en.pos.z,
            ENEMY_HALF.x,
            ENEMY_HALF.y,
            ENEMY_HALF.z,
            br,
          )
        ) {
          hitEnemyId = eid
        }
      })

      if (hitEnemyId !== null) {
        const en = enemies.current.get(hitEnemyId)
        if (en) {
          en.hp -= b.damage ?? 10
          if (en.hp <= 0) {
            const ex = en.pos.x
            const ez = en.pos.z
            enemies.current.delete(hitEnemyId)
            deadEnemyIds.push(hitEnemyId)
            if (worldSurvival) {
              const whb = worldSurvivalHpRef.current
              whb.hp = Math.min(whb.maxHp, whb.hp + ENEMY_KILL_HEAL)
              const aid = `ap-${nextAmmoPickupId.current++}`
              ammoPickupsRef.current.set(aid, {
                x: ex,
                z: ez,
                amount: AMMO_DROP_ENEMY_AMOUNT,
                respawnUntil: 0,
              })
              setAmmoPickupIds((prev) => [...prev, aid])
            }
          }
        }
        deadBullets.push(id)
        b.life = 0
        return
      }

      if (
        worldSurvival &&
        onlineMmo &&
        mpBridgeRef?.current &&
        remoteMmoPeersRef?.current
      ) {
        let hitPeerSlot = null
        remoteMmoPeersRef.current.forEach((pose, sl) => {
          if (hitPeerSlot != null || sl === slot || !pose || typeof pose.x !== 'number') return
          const py = typeof pose.y === 'number' ? pose.y : terrainHeight(pose.x, pose.z)
          const cy = py + ENEMY_HALF.y
          if (
            sphereIntersectsBox(
              b.pos.x,
              b.pos.y,
              b.pos.z,
              pose.x,
              cy,
              pose.z,
              ENEMY_HALF.x,
              ENEMY_HALF.y,
              ENEMY_HALF.z,
              br,
            )
          ) {
            hitPeerSlot = sl
          }
        })
        if (hitPeerSlot != null) {
          mpBridgeRef.current.send({
            kind: 'mmo_hit',
            victimSlot: hitPeerSlot,
            dmg: b.damage ?? 10,
            sniper: b.weaponId === 'sniper',
          })
          deadBullets.push(id)
          b.life = 0
          return
        }
      }

      if (isCtfGameMode(gameMode) && b.ownerTeam != null) {
        const cc = ctfRef.current
        const slotN = networkSlot ?? 0
        const onlineHit =
          gameMode === GAME_MODE_CTF_ONLINE && networkSlot != null && mpBridgeRef?.current
        const tryHitPlayer = (pid, pos, st) => {
          if (!st.alive) return false
          if (b.ownerTeam === st.team) return false
          const cy = pos.y + ENEMY_HALF.y
          if (
            !sphereIntersectsBox(
              b.pos.x,
              b.pos.y,
              b.pos.z,
              pos.x,
              cy,
              pos.z,
              ENEMY_HALF.x,
              ENEMY_HALF.y,
              ENEMY_HALF.z,
              br,
            )
          )
            return false
          const victimSlot = pid === 'p0' ? 0 : 1
          if (onlineHit && victimSlot !== slotN) {
            mpBridgeRef.current.send({
              kind: 'hit',
              victimSlot,
              dmg: b.damage ?? 10,
              sniper: b.weaponId === 'sniper',
            })
            return true
          }
          st.hp -= b.damage ?? 10
          bumpPlayerHitFx(hitFeedbackRef, b.weaponId === 'sniper')
          const sniperHit = b.weaponId === 'sniper'
          if (sniperHit) {
            dropCtfFlagsFromCarrier(cc, pid, pos.x, pos.y, pos.z)
            st.stunUntil = Math.max(st.stunUntil, tNow + CTF_STUN_DURATION)
          }
          if (st.hp <= 0) {
            dropCtfFlagsFromCarrier(cc, pid, pos.x, pos.y, pos.z)
            st.alive = false
            st.respawnUntil = tNow + CTF_RESPAWN_DELAY
            st.hp = 0
          }
          return true
        }
        if (tryHitPlayer('p0', p, cc.p0)) {
          deadBullets.push(id)
          b.life = 0
          return
        }
        if (tryHitPlayer('p1', player2Pos.current, cc.p1)) {
          deadBullets.push(id)
          b.life = 0
          return
        }
      }

      if (b.life <= 0) deadBullets.push(id)
    })
    deadBullets.forEach((id) => bullets.current.delete(id))
    if (deadBullets.length) setBulletIds((keys) => keys.filter((k) => !deadBullets.includes(k)))
    if (deadEnemyIds.length)
      setEnemyIds((keys) => keys.filter((k) => !deadEnemyIds.includes(k)))

    if (minimapDataRef) {
      const p2m = player2Pos.current
      if (isCtfGameMode(gameMode)) {
        const flagMini = (team) => {
          const f = ctf.flags[team]
          if (f.mode === 'base') {
            const [fx, fz] = ctfFlagWorldXZ(team)
            return { team, x: fx, z: fz }
          }
          if (f.mode === 'ground') return { team, x: f.ground.x, z: f.ground.z }
          if (f.mode === 'carried' && f.carrierKey) {
            const pos = f.carrierKey === 'p0' ? p : p2m
            return {
              team,
              x: pos.x + (team === 0 ? 0.45 : -0.45),
              z: pos.z,
            }
          }
          const [fx, fz] = ctfFlagWorldXZ(team)
          return { team, x: fx, z: fz }
        }
        minimapDataRef.current = {
          ready: true,
          mode: gameMode,
          mapHalfX: MAP_HALF_X,
          mapHalfZ: MAP_HALF_Z,
          p0: {
            x: p.x,
            z: p.z,
            alive: ctf.p0.alive,
            carry: ctfPlayerCarryingFlag(ctf, 'p0'),
          },
          p1: {
            x: p2m.x,
            z: p2m.z,
            alive: ctf.p1.alive,
            carry: ctfPlayerCarryingFlag(ctf, 'p1'),
          },
          flags: [flagMini(0), flagMini(1)],
          enemies: [],
        }
      } else {
        const ens = []
        enemies.current.forEach((en) => {
          ens.push({ x: en.pos.x, z: en.pos.z })
        })
        const peers = []
        if (gameMode === GAME_MODE_MMO_ONLINE && remoteMmoPeersRef?.current) {
          remoteMmoPeersRef.current.forEach((payload, sl) => {
            if (sl === slot) return
            if (!payload || typeof payload.x !== 'number') return
            peers.push({ slot: sl, x: payload.x, z: payload.z })
          })
        }
        const hpPacks = []
        if (worldSurvival) {
          hpPickupsRef.current.forEach((pk) => {
            if (tNow < pk.respawnUntil) return
            hpPacks.push({ x: pk.x, z: pk.z })
          })
        }
        minimapDataRef.current = {
          ready: true,
          mode: gameMode === GAME_MODE_MMO_ONLINE ? GAME_MODE_MMO_ONLINE : GAME_MODE_SOLO,
          mapHalfX: MAP_HALF_X,
          mapHalfZ: MAP_HALF_Z,
          p0: { x: p.x, z: p.z, alive: true, carry: false },
          p1: null,
          flags: [],
          enemies: ens,
          peers,
          hpPacks,
        }
      }
    }

    if (mpBridgeRef?.current && (onlineCtf || onlineMmo)) {
      lastMpSendRef.current += delta
      const mpTick = onlineMmo ? MP_MMO_POSE_TICK_SEC : MP_CTF_TICK_SEC
      if (lastMpSendRef.current >= mpTick) {
        lastMpSendRef.current = 0
        if (onlineMmo) {
          const ry0 = playerRef.current?.rotation.y ?? 0
          mpBridgeRef.current.send({
            kind: 'pose',
            slot: networkSlot ?? 0,
            x: p.x,
            z: p.z,
            y: p.y,
            ry: ry0,
          })
        } else if (onlineCtf) {
          const ry0 = playerRef.current?.rotation.y ?? 0
          const ry1 = player2Ref.current?.rotation.y ?? 0
          if (slot === 0) {
            mpBridgeRef.current.send({
              kind: 'pose',
              slot: 0,
              x: p.x,
              z: p.z,
              y: p.y,
              ry: ry0,
              hp: ctf.p0.hp,
              alive: ctf.p0.alive,
            })
            mpBridgeRef.current.send({
              kind: 'ctf',
              flags: packCtfForNet(ctf.flags),
              scores: [...ctf.scores],
              winner: ctf.winner,
            })
          } else {
            mpBridgeRef.current.send({
              kind: 'pose',
              slot: 1,
              x: p2.x,
              z: p2.z,
              y: p2.y,
              ry: ry1,
              hp: ctf.p1.hp,
              alive: ctf.p1.alive,
            })
          }
        }
      }
    }
  })

  const wallSpanX = 2 * MAP_HALF_X + 2 * WALL_THICK
  const wallSpanZ = 2 * MAP_HALF_Z + 2 * WALL_THICK
  const wallH = WALL_HEIGHT + 4.5

  return (
    <>
      <CameraRig
        targetRef={
          gameMode === GAME_MODE_CTF_ONLINE && networkSlot === 1 ? player2Ref : playerRef
        }
        zoomTargetRef={camZoomTarget}
        orbitYawRef={camOrbitYawRef}
        orbitPitchRef={camOrbitPitchRef}
        hitFxRef={hitFeedbackRef}
      />

      <ambientLight intensity={0.55} />
      <directionalLight
        position={[MAP_HALF_X * 0.22, 96, MAP_HALF_Z * 0.16]}
        intensity={1.12}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={0.5}
        shadow-camera-far={Math.min(920, MAP_HALF * 3.8)}
        shadow-camera-left={-MAP_HALF_X * 0.68}
        shadow-camera-right={MAP_HALF_X * 0.68}
        shadow-camera-top={MAP_HALF_Z * 0.68}
        shadow-camera-bottom={-MAP_HALF_Z * 0.68}
      />

      <mesh
        ref={terrainMeshRef}
        geometry={terrainGeometry}
        receiveShadow
        castShadow
      >
        <meshStandardMaterial
          color="#3d6b42"
          roughness={0.91}
          metalness={0.05}
          fog={false}
          onBeforeCompile={(shader) => {
            shader.uniforms.uEyePos = { value: new THREE.Vector3(0, 2.5, 0) }
            shader.uniforms.uSightRadius = { value: SIGHT_RADIUS }
            shader.uniforms.uVisionVigPower = { value: VISION_VIG_POWER }
            shader.uniforms.uHeightSlack = { value: VISION_HEIGHT_SLACK }
            terrainUniformsRef.current = shader.uniforms
            shader.vertexShader =
              'varying vec3 vTerrainWPos;\n' +
              shader.vertexShader.replace(
                '#include <clipping_planes_vertex>',
                `
                vTerrainWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
                #include <clipping_planes_vertex>
                `,
              )
            const terrainPrelude =
              `
              varying vec3 vTerrainWPos;
              uniform vec3 uEyePos;
              uniform float uSightRadius;
              uniform float uVisionVigPower;
              uniform float uHeightSlack;

              float terrainH(float x, float z) {
                float h = 0.0;
                h += sin(x * 0.092) * cos(z * 0.088) * 2.35;
                h += sin(x * 0.047 + 0.9) * sin(z * 0.053) * 1.95;
                h += cos(x * 0.11 + z * 0.09) * 1.15;
                h += sin((x + z) * 0.062) * 0.85;
                h += sin((x * x + z * z) * 0.00085) * 0.55;
                return clamp(h, -0.15, 4.25);
              }
              `
            let frag = terrainPrelude + shader.fragmentShader
            frag = frag.replace(
              '#include <opaque_fragment>',
              `
              float terrainVis = 1.0;
              {
                vec3 teye = uEyePos;
                vec3 ttgt = vTerrainWPos;
                float dFlat = distance(ttgt.xz, teye.xz);
                float dn = dFlat / uSightRadius;
                float inRange = pow(max(0.0, 1.0 - dn), uVisionVigPower);
                float heightOk = 1.0 - step(teye.y + uHeightSlack, ttgt.y);
                float lookDown = 1.0 - step(teye.y + 0.28, ttgt.y);
                float blockEps = mix(0.095, 0.36, lookDown);
                float blocked = 0.0;
                for (int i = 1; i < 49; i++) {
                  float t = float(i) / 49.0;
                  vec3 p = mix(teye, ttgt, t);
                  float yg = terrainH(p.x, p.z);
                  if (yg > p.y + blockEps) blocked = 1.0;
                }
                terrainVis = inRange * heightOk * (1.0 - blocked);
                float lowFloor = lookDown * inRange * 0.84;
                terrainVis = max(terrainVis, lowFloor);
              }
              outgoingLight *= terrainVis;
              if (terrainVis > 0.02) {
                float hi = smoothstep(-0.15, 3.2, vTerrainWPos.y);
                outgoingLight *= mix(0.93, 1.12, hi);
              }
              #include <opaque_fragment>
              `,
            )
            frag = frag.replace(
              '#include <dithering_fragment>',
              `
              gl_FragColor.rgb *= terrainVis;
              #include <dithering_fragment>
              `,
            )
            shader.fragmentShader = frag
          }}
        />
      </mesh>

      {isCtfGameMode(gameMode) && (
        <>
          <CtfTerritoryTint />
          <CtfBaseZone team={0} eyeRef={playerEyeWorld} />
          <CtfBaseZone team={1} eyeRef={playerEyeWorld} />
          <CtfFlagVisual
            team={0}
            ctfRef={ctfRef}
            playerPosRef={playerPos}
            player2PosRef={player2Pos}
            eyeRef={playerEyeWorld}
            gameMode={gameMode}
          />
          <CtfFlagVisual
            team={1}
            ctfRef={ctfRef}
            playerPosRef={playerPos}
            player2PosRef={player2Pos}
            eyeRef={playerEyeWorld}
            gameMode={gameMode}
          />
          <CtfFlagMapIndicator
            team={0}
            ctfRef={ctfRef}
            playerPosRef={playerPos}
            player2PosRef={player2Pos}
            playerEyeRef={playerEyeWorld}
            gameMode={gameMode}
          />
          <CtfFlagMapIndicator
            team={1}
            ctfRef={ctfRef}
            playerPosRef={playerPos}
            player2PosRef={player2Pos}
            playerEyeRef={playerEyeWorld}
            gameMode={gameMode}
          />
        </>
      )}

      {gameMode === GAME_MODE_CTF_ONLINE && (
        <CtfRemoteHpBar posRef={oppPosRef} statsRef={oppStatsRef} eyeRef={playerEyeWorld} />
      )}

      {gameMode === GAME_MODE_CTF && (
        <>
          <PlayerOverheadHpBar posRef={playerPos} statsRef={ctfP0StatsRef} eyeRef={playerEyeWorld} />
          <PlayerOverheadHpBar posRef={player2Pos} statsRef={ctfP1StatsRef} eyeRef={playerEyeWorld} />
        </>
      )}
      {gameMode === GAME_MODE_CTF_ONLINE && (
        <PlayerOverheadHpBar
          posRef={networkSlot === 1 ? player2Pos : playerPos}
          statsRef={networkSlot === 1 ? ctfP1StatsRef : ctfP0StatsRef}
          eyeRef={playerEyeWorld}
          requireAlive
        />
      )}
      {!isCtfGameMode(gameMode) && (
        <PlayerOverheadHpBar
          posRef={playerPos}
          statsRef={worldSurvivalStatsRef}
          eyeRef={playerEyeWorld}
          requireAlive={false}
        />
      )}

      {pillars.map((col, idx) => (
        <PillarLoS key={`pillar-${idx}`} col={col} eyeRef={playerEyeWorld} />
      ))}

      <mesh position={[0, wallH / 2 + 0.4, MAP_HALF_Z + WALL_THICK / 2]} castShadow receiveShadow>
        <boxGeometry args={[wallSpanX, wallH, WALL_THICK]} />
        <meshStandardMaterial color="#5c6169" roughness={0.78} metalness={0.2} />
      </mesh>
      <mesh position={[0, wallH / 2 + 0.4, -(MAP_HALF_Z + WALL_THICK / 2)]} castShadow receiveShadow>
        <boxGeometry args={[wallSpanX, wallH, WALL_THICK]} />
        <meshStandardMaterial color="#5c6169" roughness={0.78} metalness={0.2} />
      </mesh>
      <mesh position={[MAP_HALF_X + WALL_THICK / 2, wallH / 2 + 0.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[WALL_THICK, wallH, wallSpanZ]} />
        <meshStandardMaterial color="#5c6169" roughness={0.78} metalness={0.2} />
      </mesh>
      <mesh position={[-(MAP_HALF_X + WALL_THICK / 2), wallH / 2 + 0.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[WALL_THICK, wallH, wallSpanZ]} />
        <meshStandardMaterial color="#5c6169" roughness={0.78} metalness={0.2} />
      </mesh>

      <group ref={moveArrowRef} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.07, 0]}>
          <ringGeometry args={[0.4, 0.62, 44]} />
          <meshStandardMaterial
            ref={moveArrowRingMatRef}
            color="#eeff88"
            emissive="#6d7a00"
            emissiveIntensity={0.35}
            transparent
            opacity={0.75}
            depthWrite={false}
          />
        </mesh>
        <mesh geometry={wc3MoveArrowGeometry} rotation={[0, 0, 0]}>
          <meshStandardMaterial
            ref={moveArrowMatRef}
            color="#7eea57"
            emissive="#2e7d1f"
            emissiveIntensity={0.62}
            transparent
            opacity={1}
            depthWrite={false}
          />
        </mesh>
      </group>

      <group ref={attackMarkerRef} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.44, 0.58, 36]} />
          <meshStandardMaterial
            color="#b71c1c"
            emissive="#4a0000"
            emissiveIntensity={0.5}
            roughness={0.6}
            metalness={0.2}
            transparent
            opacity={0.95}
            depthWrite={false}
          />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <planeGeometry args={[0.34, 0.34]} />
          <meshStandardMaterial
            color="#ff8a65"
            emissive="#bf360c"
            emissiveIntensity={0.35}
            transparent
            opacity={0.22}
            depthWrite={false}
          />
        </mesh>
        <lineSegments
          geometry={aimSquareEdgesGeo}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.015, 0]}
        >
          <lineBasicMaterial color="#ffccbc" transparent opacity={0.9} depthWrite={false} />
        </lineSegments>
        <group ref={aimReticleArrowRef} position={[0, 0.02, 0]}>
          <mesh geometry={aimArrowGeometry} scale={0.28}>
            <meshStandardMaterial
              color="#ff5252"
              emissive="#b71c1c"
              emissiveIntensity={0.65}
              transparent
              opacity={0.95}
              depthWrite={false}
            />
          </mesh>
        </group>
      </group>

      <group ref={playerRef}>
        <mesh position={[0, 0.7, 0]} castShadow>
          <capsuleGeometry args={[0.3, 0.8, 6, 16]} />
          <meshStandardMaterial color="#2a6cff" roughness={0.45} metalness={0.15} />
        </mesh>
        <group
          ref={gunPivotRef}
          position={[0.28, 0.85, 0.15]}
          rotation={[0, 0.15, 0]}
        >
          <mesh ref={p1WeaponMgRef} castShadow position={[0, 0, 0.25]}>
            <boxGeometry args={[0.12, 0.12, 0.45]} />
            <meshStandardMaterial color="#37474f" metalness={0.4} roughness={0.45} />
          </mesh>
          <mesh ref={p1WeaponSnRef} castShadow position={[0, 0.02, 0.32]} visible={false}>
            <boxGeometry args={[0.1, 0.1, 0.72]} />
            <meshStandardMaterial color="#263238" metalness={0.55} roughness={0.35} />
          </mesh>
          <group ref={p1ClubSwingGroupRef}>
            <mesh ref={p1WeaponClubRef} castShadow position={[0, 0, 0.78]} rotation={[Math.PI / 2, 0, 0]} visible={false}>
              <cylinderGeometry args={[0.05, 0.078, 1.68, 12]} />
              <meshStandardMaterial
                color="#4e342e"
                roughness={0.72}
                metalness={0.06}
                emissive="#2d1b14"
                emissiveIntensity={0.06}
              />
            </mesh>
          </group>
        </group>
      </group>

      {gameMode === GAME_MODE_MMO_ONLINE && networkSlot != null && remoteMmoPeersRef && (
        <MmoRemoteInstancedMesh peersRef={remoteMmoPeersRef} mySlot={networkSlot} />
      )}

      {isCtfGameMode(gameMode) && (
        <group ref={player2Ref}>
          <mesh position={[0, 0.7, 0]} castShadow>
            <capsuleGeometry args={[0.3, 0.8, 6, 16]} />
            <meshStandardMaterial color="#ff6f00" roughness={0.45} metalness={0.15} />
          </mesh>
          <group
            ref={gunPivot2Ref}
            position={[-0.28, 0.85, 0.15]}
            rotation={[0, -0.15, 0]}
          >
            <mesh ref={p2WeaponMgRef} castShadow position={[0, 0, 0.25]}>
              <boxGeometry args={[0.12, 0.12, 0.45]} />
              <meshStandardMaterial color="#37474f" metalness={0.4} roughness={0.45} />
            </mesh>
            <mesh ref={p2WeaponSnRef} castShadow position={[0, 0.02, 0.32]} visible={false}>
              <boxGeometry args={[0.1, 0.1, 0.72]} />
              <meshStandardMaterial color="#263238" metalness={0.55} roughness={0.35} />
            </mesh>
            <group ref={p2ClubSwingGroupRef}>
              <mesh ref={p2WeaponClubRef} castShadow position={[0, 0, 0.78]} rotation={[Math.PI / 2, 0, 0]} visible={false}>
                <cylinderGeometry args={[0.05, 0.078, 1.68, 12]} />
                <meshStandardMaterial
                  color="#4e342e"
                  roughness={0.72}
                  metalness={0.06}
                  emissive="#2d1b14"
                  emissiveIntensity={0.06}
                />
              </mesh>
            </group>
          </group>
        </group>
      )}

      {!isCtfGameMode(gameMode) &&
        hpPickupIdList.map((hid) => (
          <HpPickupOrb key={hid} id={hid} pickupsRef={hpPickupsRef} eyeRef={playerEyeWorld} />
        ))}

      {!isCtfGameMode(gameMode) &&
        ammoPickupIds.map((aid) => (
          <AmmoPickupOrb key={aid} id={aid} pickupsRef={ammoPickupsRef} eyeRef={playerEyeWorld} />
        ))}

      {!isCtfGameMode(gameMode) &&
        crateIds.map((cid) => (
          <LootCrateUnit key={cid} id={cid} cratesRef={cratesRef} eyeRef={playerEyeWorld} />
        ))}

      {enemyIds.map((id) => (
        <EnemyUnit key={id} id={id} enemiesRef={enemies} eyeRef={playerEyeWorld} />
      ))}

      {bulletIds.map((id) => (
        <BulletMesh key={id} id={id} bulletsRef={bullets} eyeRef={playerEyeWorld} />
      ))}
    </>
  )
}

export default function App() {
  const hudRefs = useRef({
    weapon: null,
    status: null,
    bar: null,
    track: null,
    worldHp: null,
    worldHpBar: null,
    ctfScore: null,
    ctfHint: null,
  })
  const minimapDataRef = useRef({
    ready: true,
    mode: GAME_MODE_SOLO,
    mapHalfX: MAP_HALF_X,
    mapHalfZ: MAP_HALF_Z,
    p0: { x: 0, z: 0, alive: true, carry: false },
    p1: null,
    flags: [],
    enemies: [],
  })
  const [gameCursor, setGameCursor] = useState(CURSOR_RTS_GAUNTLET)
  const [gameMode, setGameMode] = useState(null)
  const [networkSlot, setNetworkSlot] = useState(null)
  const [mpRoomId, setMpRoomId] = useState('public')
  const [mpWsUrl, setMpWsUrl] = useState(() =>
    import.meta.env.VITE_MP_WS ? String(import.meta.env.VITE_MP_WS) : inferMpWsUrl(),
  )
  const [menuMpAdvanced, setMenuMpAdvanced] = useState(false)
  const mpBridgeRef = useRef(null)

  useEffect(() => {
    if (import.meta.env.VITE_MP_WS) return
    let cancelled = false
    fetch(mpWsConfigFetchUrl(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j || typeof j.mpWsUrl !== 'string') return
        const u = j.mpWsUrl.trim()
        if (!u) return
        setMpWsUrl(u)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  const remoteBufferRef = useRef({ p0: null, p1: null, ctf: null })
  const remoteMmoPeersRef = useRef(new Map())
  const pendingHitRef = useRef(null)
  const pendingMmoHitRef = useRef(null)
  const hitFeedbackRef = useRef({ vignette: 0, shake: 0, flash: 0 })

  const goMenu = () => {
    mpBridgeRef.current?.close()
    mpBridgeRef.current = null
    setNetworkSlot(null)
    remoteBufferRef.current = { p0: null, p1: null, ctf: null }
    remoteMmoPeersRef.current.clear()
    pendingHitRef.current = null
    pendingMmoHitRef.current = null
    const fx = hitFeedbackRef.current
    if (fx) {
      fx.vignette = 0
      fx.shake = 0
      fx.flash = 0
    }
    setGameMode(null)
  }

  const connectOnlineCtf = (overrides = {}) => {
    mpBridgeRef.current?.close()
    const room = String(overrides.room ?? mpRoomId).trim() || 'public'
    const raw = String(overrides.wsUrl ?? mpWsUrl).trim() || inferMpWsUrl()
    const url = raw.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://')
    const b = createMpBridge(url, room, {
      onWelcome: (m) => {
        setNetworkSlot(m.slot)
        setGameMode(GAME_MODE_CTF_ONLINE)
      },
      onPeer: (_from, payload) => {
        if (!payload || typeof payload !== 'object') return
        if (payload.kind === 'pose') {
          if (payload.slot === 0) remoteBufferRef.current.p0 = payload
          else remoteBufferRef.current.p1 = payload
        } else if (payload.kind === 'ctf') {
          remoteBufferRef.current.ctf = payload
        } else if (payload.kind === 'hit') {
          pendingHitRef.current = payload
        } else if (payload.kind === '_peer_left' && payload.slot != null) {
          if (payload.slot === 0) remoteBufferRef.current.p0 = null
          else if (payload.slot === 1) remoteBufferRef.current.p1 = null
        }
      },
      onError: (err) => {
        const msg = err?.message
        window.alert(
          msg === 'room_full'
            ? '방이 가득 찼습니다 (서버 한도, 기본 최대 64명 — MP_MAX_PLAYERS).'
            : '연결 오류 — mp-server가 켜져 있는지 확인하세요.',
        )
      },
    })
    mpBridgeRef.current = b
    b.connect()
  }

  const connectMmoOnline = (overrides = {}) => {
    mpBridgeRef.current?.close()
    remoteMmoPeersRef.current.clear()
    const room = String(overrides.room ?? mpRoomId).trim() || 'public'
    const raw = String(overrides.wsUrl ?? mpWsUrl).trim() || inferMpWsUrl()
    const url = raw.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://')
    const b = createMpBridge(url, room, {
      onWelcome: (m) => {
        setNetworkSlot(m.slot)
        setGameMode(GAME_MODE_MMO_ONLINE)
      },
      onPeer: (from, payload) => {
        if (!payload || typeof payload !== 'object') return
        if (payload.kind === 'pose' && from >= 0) {
          remoteMmoPeersRef.current.set(from, payload)
        } else if (payload.kind === '_peer_left' && payload.slot != null) {
          remoteMmoPeersRef.current.delete(payload.slot)
        } else if (payload.kind === 'mmo_hit') {
          pendingMmoHitRef.current = payload
        }
      },
      onError: (err) => {
        const msg = err?.message
        window.alert(
          msg === 'room_full'
            ? '방이 가득 찼습니다 (서버 한도, 기본 최대 64명).'
            : '연결 오류 — mp-server가 켜져 있는지 확인하세요.',
        )
      },
    })
    mpBridgeRef.current = b
    b.connect()
  }

  if (gameMode === null) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
          background: 'linear-gradient(160deg,#0d1420,#1a2740)',
          fontFamily: 'system-ui, sans-serif',
          color: '#e8eefc',
        }}
      >
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>Gun Fight</h1>
        <p style={{ opacity: 0.78, margin: 0, maxWidth: 560, textAlign: 'center', lineHeight: 1.55 }}>
          맵은 넓은 <strong style={{ fontWeight: 650 }}>오픈 필드</strong>입니다.{' '}
          <strong style={{ fontWeight: 650 }}>오픈월드 MMO</strong>는 같은 방에 여러 명이 동시에 들어와 탐험·사냥(릴레이 서버)하고,{' '}
          <strong style={{ fontWeight: 650 }}>온라인 깃발</strong>은 2인 팀 대전입니다.{' '}
          <code style={{ opacity: 0.9 }}>npm run mp-server</code> 를 먼저 실행하세요.
        </p>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={() => connectMmoOnline()}
            style={{
              padding: '16px 26px',
              fontSize: 17,
              fontWeight: 700,
              borderRadius: 12,
              border: '1px solid rgba(200, 140, 255, 0.5)',
              background: 'linear-gradient(180deg, rgba(120,60,180,0.55), rgba(70,30,120,0.5))',
              color: '#fff',
              cursor: 'pointer',
              boxShadow: '0 6px 24px rgba(40,0,80,0.35)',
            }}
          >
            오픈월드 MMO 입장
          </button>
          <button
            type="button"
            onClick={() => connectOnlineCtf()}
            style={{
              padding: '16px 26px',
              fontSize: 16,
              fontWeight: 700,
              borderRadius: 12,
              border: '1px solid rgba(130, 210, 255, 0.45)',
              background: 'linear-gradient(180deg, rgba(45,140,220,0.5), rgba(25,90,170,0.45))',
              color: '#fff',
              cursor: 'pointer',
              boxShadow: '0 6px 24px rgba(0,40,80,0.35)',
            }}
          >
            온라인 깃발 (2인)
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 12, opacity: 0.62, maxWidth: 480, textAlign: 'center' }}>
          기본 방 <code style={{ opacity: 0.9 }}>public</code> · 로컬은 <code style={{ opacity: 0.9 }}>:8787</code> ·
          MMO는 방당 최대 64명(<code style={{ opacity: 0.9 }}>MP_MAX_PLAYERS</code>) · 배포 시{' '}
          <code style={{ opacity: 0.9 }}>public/mp-ws-config.json</code> 또는 빌드 변수{' '}
          <code style={{ opacity: 0.9 }}>VITE_MP_WS</code>
        </p>
        {showHostedRelayUrlWarning(mpWsUrl) && (
          <p
            style={{
              margin: 0,
              fontSize: 11,
              opacity: 0.88,
              maxWidth: 440,
              textAlign: 'center',
              lineHeight: 1.45,
              color: '#ffcc80',
            }}
          >
            이 사이트(HTTPS)에는 WebSocket 릴레이가 없습니다. <code style={{ opacity: 0.95 }}>public/mp-ws-config.json</code>에{' '}
            <code style={{ opacity: 0.95 }}>mpWsUrl</code>을 <code style={{ opacity: 0.95 }}>wss://…</code> 로 넣어 배포하거나, 아래{' '}
            <strong>연결 설정</strong>에서 주소를 입력하세요.
          </p>
        )}
        <button
          type="button"
          onClick={() => setMenuMpAdvanced((v) => !v)}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'transparent',
            color: 'rgba(232,238,252,0.75)',
            cursor: 'pointer',
          }}
        >
          {menuMpAdvanced ? '연결 설정 닫기' : '연결 설정 (URL · 방 이름)'}
        </button>
        {menuMpAdvanced && (
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(0,0,0,0.22)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              minWidth: 300,
              maxWidth: 420,
            }}
          >
            <label style={{ fontSize: 12, opacity: 0.85, display: 'flex', flexDirection: 'column', gap: 4 }}>
              WebSocket URL
              <input
                value={mpWsUrl}
                onChange={(e) => setMpWsUrl(e.target.value)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#fff',
                }}
              />
            </label>
            <label style={{ fontSize: 12, opacity: 0.85, display: 'flex', flexDirection: 'column', gap: 4 }}>
              방 ID (둘 다 동일하게)
              <input
                value={mpRoomId}
                onChange={(e) => setMpRoomId(e.target.value)}
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#fff',
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => connectMmoOnline()}
                style={{
                  padding: '10px 14px',
                  fontSize: 13,
                  fontWeight: 650,
                  borderRadius: 10,
                  border: '1px solid rgba(180,120,255,0.4)',
                  background: 'rgba(90,40,140,0.4)',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                MMO로 입장
              </button>
              <button
                type="button"
                onClick={() => connectOnlineCtf()}
                style={{
                  padding: '10px 14px',
                  fontSize: 13,
                  fontWeight: 650,
                  borderRadius: 10,
                  border: '1px solid rgba(120,200,255,0.35)',
                  background: 'rgba(30,120,200,0.35)',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                깃발로 입장
              </button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
          <button
            type="button"
            onClick={() => setGameMode(GAME_MODE_SOLO)}
            style={{
              padding: '12px 20px',
              fontSize: 15,
              fontWeight: 650,
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(42,108,255,0.22)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            솔로 (봇)
          </button>
          <button
            type="button"
            onClick={() => setGameMode(GAME_MODE_CTF)}
            style={{
              padding: '12px 20px',
              fontSize: 14,
              fontWeight: 600,
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,111,0,0.14)',
              color: 'rgba(255,240,230,0.88)',
              cursor: 'pointer',
            }}
          >
            같은 PC · 키보드 2인 (로컬)
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        margin: 0,
        overflow: 'hidden',
        touchAction: 'none',
        cursor: gameCursor,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Canvas
        shadows
        camera={{ fov: 42, near: 0.1, far: 1400, position: [26, 22, 26] }}
        gl={{ antialias: true }}
        onCreated={({ camera }) => camera.lookAt(0, 0.75, 0)}
        style={{ width: '100%', height: '100%', display: 'block', cursor: 'inherit' }}
      >
        <color attach="background" args={['#87b8e8']} />
        <fog attach="fog" args={['#7aabdc', 220, 720]} />
        <GameScene
          key={`${gameMode}-${networkSlot ?? 'local'}`}
          hudRefs={hudRefs}
          setGameCursor={setGameCursor}
          gameMode={gameMode}
          minimapDataRef={minimapDataRef}
          networkSlot={networkSlot}
          remoteBufferRef={remoteBufferRef}
          remoteMmoPeersRef={remoteMmoPeersRef}
          mpBridgeRef={mpBridgeRef}
          pendingHitRef={pendingHitRef}
          pendingMmoHitRef={pendingMmoHitRef}
          hitFeedbackRef={hitFeedbackRef}
        />
      </Canvas>
      <HitFeedbackOverlay fxRef={hitFeedbackRef} />
      <Wc3Minimap dataRef={minimapDataRef} />
      <div
        style={{
          position: 'fixed',
          right: 16,
          top: 16,
          width: 220,
          padding: '12px 14px',
          borderRadius: 10,
          background: 'rgba(12, 18, 28, 0.72)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
          fontFamily: 'system-ui, sans-serif',
          color: '#e8eefc',
          pointerEvents: 'none',
          lineHeight: 1.45,
        }}
      >
        <div style={{ fontSize: 11, opacity: 0.72, letterSpacing: '0.04em', marginBottom: 4 }}>
          장비
        </div>
        <div
          ref={(el) => {
            hudRefs.current.weapon = el
          }}
          style={{ fontSize: 15, fontWeight: 650, textShadow: '0 1px 2px #000' }}
        >
          기관총  ·  [1]
        </div>
        <div
          ref={(el) => {
            hudRefs.current.status = el
          }}
          style={{ fontSize: 12, marginTop: 8, opacity: 0.9 }}
        >
          발사 가능
        </div>
        <div
          ref={(el) => {
            hudRefs.current.track = el
          }}
          title=""
          style={{
            marginTop: 8,
            height: 8,
            borderRadius: 4,
            background: 'rgba(255,255,255,0.12)',
            overflow: 'hidden',
          }}
        >
          <div
            ref={(el) => {
              hudRefs.current.bar = el
            }}
            style={{
              height: '100%',
              width: '100%',
              borderRadius: 4,
              transition: 'width 0.05s linear',
              background: 'linear-gradient(90deg,#69f0ae,#00e676)',
            }}
          />
        </div>
        <div style={{ fontSize: 10, opacity: 0.55, marginTop: 6 }}>
          {isCtfGameMode(gameMode)
            ? '숫자 1 · 기관총 / 숫자 2 · 스나이퍼'
            : '스페이스 점프 · 1·기관총 2·스나이퍼(상자) 3·몽둥이 · 탄 공용 · 기관 3발당 탄1'}
        </div>
      </div>
      {(gameMode === GAME_MODE_SOLO || gameMode === GAME_MODE_MMO_ONLINE) && (
        <div
          style={{
            position: 'fixed',
            right: 16,
            top: 132,
            width: 240,
            padding: '12px 14px',
            borderRadius: 10,
            background: 'rgba(12, 36, 28, 0.78)',
            border: '1px solid rgba(0, 230, 150, 0.22)',
            boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
            fontFamily: 'system-ui, sans-serif',
            color: '#e8fff4',
            pointerEvents: 'none',
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontSize: 11, opacity: 0.75, letterSpacing: '0.04em', marginBottom: 4 }}>
            생존 HP
          </div>
          <div
            ref={(el) => {
              hudRefs.current.worldHp = el
            }}
            style={{ fontSize: 13, fontWeight: 650, textShadow: '0 1px 2px #000' }}
          >
            생존 HP 100 / 100 · −1/초 · 팩 +25
          </div>
          <div
            style={{
              marginTop: 8,
              height: 9,
              borderRadius: 4,
              background: 'rgba(0,0,0,0.35)',
              overflow: 'hidden',
            }}
          >
            <div
              ref={(el) => {
                hudRefs.current.worldHpBar = el
              }}
              style={{
                height: '100%',
                width: '100%',
                borderRadius: 4,
                background: 'linear-gradient(90deg,#69f0ae,#00c853)',
              }}
            />
          </div>
        </div>
      )}
      {isCtfGameMode(gameMode) && (
        <div
          style={{
            position: 'fixed',
            right: 16,
            top: 200,
            width: 280,
            padding: '12px 14px',
            borderRadius: 10,
            background: 'rgba(12, 18, 28, 0.72)',
            border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
            fontFamily: 'system-ui, sans-serif',
            color: '#e8eefc',
            pointerEvents: 'none',
            lineHeight: 1.45,
          }}
        >
          <div style={{ fontSize: 11, opacity: 0.72, letterSpacing: '0.04em', marginBottom: 6 }}>
            깃발 점수 (먼저 {CTF_SCORE_TO_WIN}점)
          </div>
          <div
            ref={(el) => {
              hudRefs.current.ctfScore = el
            }}
            style={{ fontSize: 17, fontWeight: 700 }}
          >
            파랑 0 · 주황 0
          </div>
          <div
            ref={(el) => {
              hudRefs.current.ctfHint = el
            }}
            style={{ fontSize: 11, marginTop: 10, opacity: 0.88 }}
          >
            깃발: 우리 깃발이 기지에 있을 때만 적 깃발로 득점 · 드랍: 사망·스나이퍼 스턴 · 아군 깃발 바닥=즉시 복귀 · 깃발 들면 이동 20%↓
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={goMenu}
        style={{
          position: 'fixed',
          left: 12,
          top: 12,
          padding: '8px 12px',
          fontSize: 12,
          fontWeight: 600,
          borderRadius: 8,
          border: '1px solid rgba(255,255,255,0.2)',
          background: 'rgba(12, 18, 28, 0.75)',
          color: '#e8eefc',
          cursor: 'pointer',
          zIndex: 10,
        }}
      >
        모드 선택
      </button>
      <div
        style={{
          position: 'fixed',
          left: 12,
          bottom: 12,
          color: '#f0f4ff',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 13,
          textShadow: '0 1px 2px #000',
          pointerEvents: 'none',
          lineHeight: 1.5,
          maxWidth: 'min(920px, 96vw)',
        }}
      >
        {gameMode === GAME_MODE_MMO_ONLINE ? (
          <>
            오픈월드 MMO · 생존 HP 1/초 감소 · 녹색 팩 +25 · 붉은 적 · 보라=다른 유저(PvP) · 우클릭 이동·카메라 · A 조준 ·
            1·2·3 무기
          </>
        ) : gameMode === GAME_MODE_CTF_ONLINE ? (
          <>
            온라인 깃발 · 첫 입장=파랑(우클릭 이동·드래그로 방향) · 두 번째=주황(IJKL·F·우클릭 이동·드래그 방향) · A
            조준 · 1·2 무기 · 상대 체력바는 머리 위 · 휠 시야 · 깃발·점수는 파랑(호스트) 기준 동기화
          </>
        ) : gameMode === GAME_MODE_CTF ? (
          <>
            파랑(P1): A 조준 · 좌클릭 발사 · 우클릭 이동 · 우클릭 드래그 시 방향 · 1·2 무기 · 스나이퍼 피격 시 스턴+깃발 드랍 ·
            주황(P2): IJKL 이동 · F 기관총 · 휠 시야 · 좌하 미니맵 · 바닥 색: 서쪽 파랑=아군 · 동쪽 붉은=적 · 상대 체력바 머리
            위
          </>
        ) : (
          <>
            솔로 · 생존 HP 1/초 감소 · 녹색 회전 팩 +25(랜덤 위치) · A 조준 · 좌클릭 발사 · 우클릭 이동·카메라 · 1·2 무기 · 휠
            시야
          </>
        )}
      </div>
    </div>
  )
}
