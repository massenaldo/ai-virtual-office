import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { CharacterLook } from './characterLook'

// A character is built in metres, standing on y = 0 at its origin and facing -Z. Its right hand is on +X. Seated, the origin is the
// seat point (the middle of the chair seat), so the desk is in front, at about z = -0.56. All angles are in radians.

export type CharacterAction = 'idle' | 'typing' | 'thinking' | 'waiting' | 'error' | 'done'
export type CharacterStatus = 'idle' | 'working' | 'thinking' | 'waiting' | 'error'

/** How long the done gesture plays after a task finishes. */
export const DONE_GESTURE_MS = 4000

const ACTION_BY_STATUS: Record<Exclude<CharacterStatus, 'idle'>, CharacterAction> = {
  working: 'typing',
  thinking: 'thinking',
  waiting: 'waiting',
  error: 'error',
}

/**
 * What a character does. A live status wins. An idle character gestures for a few seconds after `doneAt`; a missing, invalid,
 * future or old `doneAt` means plain idle, so a reload long after a task finished plays nothing.
 */
export function characterAction(status: CharacterStatus, doneAt: number | null, nowMs: number): CharacterAction {
  if (status !== 'idle') return ACTION_BY_STATUS[status] ?? 'idle'
  if (doneAt === null || !Number.isFinite(doneAt) || !Number.isFinite(nowMs)) return 'idle'
  const age = nowMs - doneAt
  return age >= 0 && age < DONE_GESTURE_MS ? 'done' : 'idle'
}

// ---------------------------------------------------------------- body dimensions

const HIP_DROP = 0.03 // leg pivots sit this far below the hips pivot
const WAIST = 0.06 // spine pivot above the hips pivot
const SHOULDER_Y = 0.4 // shoulder pivots above the spine pivot
const NECK_Y = 0.45 // neck base above the spine pivot
const SHOULDER_X = 0.185
const HIP_X = 0.085
const UPPER_ARM = 0.29
const FOREARM = 0.26
const THIGH = 0.42
const SHIN = 0.4
const FOOT = 0.07 // ankle to sole
/** Hand centre, in forearm coordinates. */
export const HAND_POINT = new THREE.Vector3(0, -(FOREARM + 0.05), 0)
/** The sole of the foot, in shin coordinates. */
export const SOLE_POINT = new THREE.Vector3(0, -(SHIN + FOOT), 0)
/** The top of the head, hair and head covering included, in head coordinates. */
export const HEAD_TOP_POINT = new THREE.Vector3(0, 0.27, 0)
/** The upper body of a woman is a little smaller than a man's. Legs, and so the seat, are shared. */
const UPPER_BODY_SCALE: Record<CharacterLook['body'], number> = { man: 1, woman: 0.955 }

// ---------------------------------------------------------------- joints and pose

export const JOINTS = ['hips', 'spine', 'head', 'upperArmL', 'upperArmR', 'forearmL', 'forearmR', 'thighL', 'thighR', 'shinL', 'shinR'] as const
export type Joint = (typeof JOINTS)[number]

/**
 * Every joint angle and the hip position, flat. Positive pitch swings a limb forward. `spine` leans the body forward and
 * `headPitch` looks down. `elbowX` and `kneeX` are flexion, always bending the natural way. `armXOut` lifts an arm sideways.
 */
export type Pose = {
  hipsY: number
  hipsZ: number
  spine: number
  spineRoll: number
  headPitch: number
  headYaw: number
  headRoll: number
  armL: number
  armLOut: number
  elbowL: number
  armR: number
  armROut: number
  elbowR: number
  thighL: number
  kneeL: number
  thighR: number
  kneeR: number
}
const POSE_KEYS = [
  'hipsY', 'hipsZ', 'spine', 'spineRoll', 'headPitch', 'headYaw', 'headRoll', 'armL', 'armLOut', 'elbowL', 'armR', 'armROut', 'elbowR',
  'thighL', 'kneeL', 'thighR', 'kneeR',
] as const satisfies readonly (keyof Pose)[]

const SEAT_HIPS_Y = 0.585 // the pelvis rests on the chair cushion
const SEAT_HIPS_Z = 0.04
const STAND_HIPS_Y = HIP_DROP + THIGH + SHIN + FOOT
const SEATED_LEGS = { thighL: 1.42, thighR: 1.42, kneeL: 1.5, kneeR: 1.5 }

type Arms = Pick<Pose, 'armL' | 'armLOut' | 'elbowL' | 'armR' | 'armROut' | 'elbowR'>
type Upper = Pick<Pose, 'spine' | 'spineRoll' | 'headPitch' | 'headYaw' | 'headRoll'>

const wave = (timeS: number, phase: number, hz: number) => Math.sin((timeS * hz + phase) * Math.PI * 2)

// Seated, the hands rest on the keyboard, near the chin, in the lap or in the air. The arm angles were solved onto those targets,
// the keyboard at (+-0.1, 0.8, -0.42) for one, and are checked in characterRig.test.ts.
const REST = { armL: 0.09, armLOut: -0.05, elbowL: 1.49, armR: 0.09, armROut: -0.05, elbowR: 1.49 }

function seatedArms(action: CharacterAction, t: number, p: number): Arms {
  switch (action) {
    case 'typing': {
      const l = wave(t, p, 2.3) * 0.035
      const r = wave(t, p + 0.37, 2.9) * 0.035
      return { armL: 0.48, armLOut: -0.24, elbowL: 1.34 - l, armR: 0.48, armROut: -0.24, elbowR: 1.34 - r }
    }
    case 'thinking':
      return { armL: 0.08, armLOut: -0.06, elbowL: 1.55, armR: 0.79 + wave(t, p, 0.2) * 0.02, armROut: -0.55, elbowR: 2.42 }
    case 'waiting': {
      const w = wave(t, p, 1.1) * 0.22
      return { armL: 0.08, armLOut: -0.06, elbowL: 1.55, armR: 2.9, armROut: 0.18, elbowR: 0.45 + w }
    }
    case 'error':
      return { armL: 0.2, armLOut: 0.1, elbowL: 0.3, armR: 0.2, armROut: 0.1, elbowR: 0.3 }
    case 'done': {
      const b = wave(t, p, 2) * 0.06
      return { armL: 0.08, armLOut: -0.06, elbowL: 1.55, armR: 1.76 + b, armROut: 0.21, elbowR: 1.33 }
    }
    default:
      return REST
  }
}

function seatedUpper(action: CharacterAction, t: number, p: number): Upper {
  const breath = wave(t, p, 0.27) * 0.012
  const drift = wave(t, p + 0.2, 0.09)
  switch (action) {
    case 'typing':
      return { spine: 0.16 + breath, spineRoll: 0, headPitch: 0.16 + wave(t, p, 0.3) * 0.02, headYaw: wave(t, p, 0.5) * 0.04, headRoll: 0 }
    case 'thinking':
      return { spine: 0.08 + breath, spineRoll: 0.03, headPitch: -0.04, headYaw: 0.18 + drift * 0.05, headRoll: -0.1 }
    case 'waiting':
      return { spine: 0.02 + breath, spineRoll: -0.04, headPitch: -0.04, headYaw: drift * 0.1, headRoll: 0.05 }
    case 'error':
      return { spine: 0.5, spineRoll: 0.04, headPitch: 0.55, headYaw: 0, headRoll: 0.06 }
    case 'done':
      return { spine: -0.04, spineRoll: 0, headPitch: -0.1, headYaw: 0.1, headRoll: 0.04 }
    default:
      return { spine: 0.05 + breath, spineRoll: 0, headPitch: 0.03, headYaw: drift * 0.12, headRoll: drift * 0.02 }
  }
}

// Standing, the arms do the same job in front of the body, a little lower, since there is no desk to reach.
function standingArms(action: CharacterAction, t: number, p: number): Arms {
  switch (action) {
    case 'typing': {
      const l = wave(t, p, 2.3) * 0.035
      return { armL: -0.06, armLOut: -0.24, elbowL: 1.63 - l, armR: -0.06, armROut: -0.24, elbowR: 1.63 + l }
    }
    case 'thinking':
      return { armL: 0.0, armLOut: -0.1, elbowL: 1.6, armR: 0.79, armROut: -0.55, elbowR: 2.42 }
    case 'waiting':
      return { armL: 0.1, armLOut: 0.1, elbowL: 0.2, armR: 2.9, armROut: 0.18, elbowR: 0.45 + wave(t, p, 1.1) * 0.22 }
    case 'error':
      return { armL: 0.1, armLOut: 0.1, elbowL: 0.25, armR: 0.1, armROut: 0.1, elbowR: 0.25 }
    case 'done':
      return { armL: 0.1, armLOut: 0.1, elbowL: 0.2, armR: 1.62 + wave(t, p, 2) * 0.06, armROut: 0.32, elbowR: 1.74 }
    default:
      return { armL: 0.06 + wave(t, p, 0.2) * 0.01, armLOut: 0.12, elbowL: 0.2, armR: 0.06, armROut: 0.12, elbowR: 0.2 }
  }
}

/**
 * The pose a character is heading for. `timeS` moves breathing, typing and waving, and `phase` (any number, the same for a given
 * character) keeps characters out of step. It is a target: `stepPose` eases the real pose toward it.
 */
export function targetPose(action: CharacterAction, seated: boolean, timeS: number, phase: number): Pose {
  const t = Number.isFinite(timeS) ? timeS : 0
  const p = Number.isFinite(phase) ? phase : 0
  const upper = seatedUpper(action, t, p)
  if (seated) {
    return { hipsY: SEAT_HIPS_Y, hipsZ: SEAT_HIPS_Z, ...upper, ...seatedArms(action, t, p), ...SEATED_LEGS }
  }
  const stand = { ...upper, spine: action === 'error' ? 0.35 : upper.spine * 0.4, headPitch: upper.headPitch }
  return {
    hipsY: STAND_HIPS_Y,
    hipsZ: 0,
    ...stand,
    ...standingArms(action, t, p),
    thighL: 0.01 + wave(t, p, 0.2) * 0.01,
    thighR: -0.01,
    kneeL: 0.02,
    kneeR: 0.02,
  }
}

const RATE = 9 // per second; a pose covers 90% of the way to its target in about a quarter of a second
const SNAP = 0.002

/**
 * Eases the current pose toward its target. The step is exponential, so it never overshoots, and any long gap, such as a tab
 * that was hidden for an hour, lands exactly on the target in one go. `settled` says nothing is moving any more.
 */
export function stepPose(current: Pose, target: Pose, dtS: number): { pose: Pose; settled: boolean } {
  const dt = Number.isFinite(dtS) ? Math.max(0, dtS) : 0
  const k = 1 - Math.exp(-RATE * dt)
  const pose = { ...target }
  let settled = true
  for (const key of POSE_KEYS) {
    const from = Number.isFinite(current[key]) ? current[key] : target[key]
    const gap = target[key] - from
    if (Math.abs(gap) <= SNAP || k >= 0.999999) {
      pose[key] = target[key]
    } else {
      pose[key] = from + gap * k
      settled = false
    }
  }
  return { pose, settled }
}


const put = (out: THREE.Matrix4[], joint: Joint, value: THREE.Matrix4) => {
  const i = JOINTS.indexOf(joint)
  ;(out[i] ??= new THREE.Matrix4()).copy(value)
}
const mul = (parent: THREE.Matrix4, ...steps: THREE.Matrix4[]) => {
  const r = new THREE.Matrix4().copy(parent)
  for (const s of steps) r.multiply(s)
  return r
}
const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z)
const RX = (a: number) => new THREE.Matrix4().makeRotationX(a)
const RY = (a: number) => new THREE.Matrix4().makeRotationY(a)
const RZ = (a: number) => new THREE.Matrix4().makeRotationZ(a)

/**
 * Writes each joint's matrix, relative to the character's origin, into `out` in `JOINTS` order. Pass the look's body to give a woman
 * a slightly smaller upper body; the default is a man's.
 */
export function jointMatrices(pose: Pose, out: THREE.Matrix4[], build: CharacterLook['body'] = 'man'): void {
  const s = UPPER_BODY_SCALE[build]
  const hips = T(0, pose.hipsY, pose.hipsZ)
  put(out, 'hips', hips)
  const spineM = mul(hips, T(0, WAIST, 0), RX(-pose.spine), RZ(pose.spineRoll), new THREE.Matrix4().makeScale(s, s, s))
  put(out, 'spine', spineM)
  put(out, 'head', mul(spineM, T(0, NECK_Y, 0), RY(pose.headYaw), RX(-pose.headPitch), RZ(pose.headRoll)))
  for (const side of [-1, 1] as const) {
    const left = side === -1
    const arm = left ? pose.armL : pose.armR
    const out_ = left ? pose.armLOut : pose.armROut
    const elbow = left ? pose.elbowL : pose.elbowR
    const upper = mul(spineM, T(side * SHOULDER_X, SHOULDER_Y, 0), RX(arm), RZ(side * out_))
    put(out, left ? 'upperArmL' : 'upperArmR', upper)
    put(out, left ? 'forearmL' : 'forearmR', mul(upper, T(0, -UPPER_ARM, 0), RX(elbow)))
    const hip = mul(hips, T(side * HIP_X, -HIP_DROP, 0), RX(left ? pose.thighL : pose.thighR))
    put(out, left ? 'thighL' : 'thighR', hip)
    put(out, left ? 'shinL' : 'shinR', mul(hip, T(0, -THIGH, 0), RX(-(left ? pose.kneeL : pose.kneeR))))
  }
}

// ---------------------------------------------------------------- parts

export type CharacterPart =
  | 'skin' | 'eyes'
  | 'hairShort' | 'hairSide' | 'hairBun' | 'hairLong' | 'hijab'
  | 'shirt' | 'blazer' | 'blazerShirt' | 'sweater' | 'tunic'
  | 'accent' | 'trousers' | 'shoes' | 'badge'

export type CharacterPartEntry = { part: CharacterPart; joint: Joint; geometry: THREE.BufferGeometry; castShadow: boolean }

const HAIR_PART: Record<CharacterLook['hair'], CharacterPart> = {
  short: 'hairShort', side: 'hairSide', bun: 'hairBun', long: 'hairLong', hijab: 'hijab',
}

const BADGE_COLOR = '#e5484d'
const EYE_COLOR = '#2a2420'
const SHOE_COLOR = '#2a2622'

const luma = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}

/**
 * The colour of a part for this look, or null when the look does not use it. The accent, the department colour, is always used.
 * A head covering takes the trouser colour, so it reads against the top; the hair parts take the hair colour.
 */
export function partColor(part: CharacterPart, look: CharacterLook, accent: string): string | null {
  switch (part) {
    case 'skin': return look.skin
    case 'eyes': return EYE_COLOR
    case 'hairShort': case 'hairSide': case 'hairBun': case 'hairLong': return HAIR_PART[look.hair] === part ? look.hairColor : null
    case 'hijab': return look.hair === 'hijab' ? look.trousers : null
    case 'shirt': return look.cut === 'shirt' ? look.clothing : null
    case 'blazer': return look.cut === 'blazer' ? look.clothing : null
    case 'blazerShirt': return look.cut === 'blazer' ? (luma(look.clothing) > 0.6 ? '#4a5568' : '#f2efe9') : null
    case 'sweater': return look.cut === 'sweater' ? look.clothing : null
    case 'tunic': return look.cut === 'tunic' ? look.clothing : null
    case 'accent': return accent
    case 'trousers': return look.trousers
    case 'shoes': return SHOE_COLOR
    case 'badge': return BADGE_COLOR
  }
}

/** Parts that are drawn only for some actions. Today that is the error badge. */
export function partVisible(part: CharacterPart, action: CharacterAction): boolean {
  return part === 'badge' ? action === 'error' : true
}

// Geometry helpers. Every piece is an ellipsoid or a tube, so the figure stays soft and cheap.
const sph = (rx_: number, ry: number, rz: number, x: number, y: number, z: number, w = 8, h = 6) =>
  new THREE.SphereGeometry(1, w, h).scale(rx_, ry, rz).translate(x, y, z)
/** A tapered tube from y0 (radius r0) down to y1 (radius r1), open at both ends. */
const tube = (r0: number, r1: number, y0: number, y1: number, seg = 8, sz = 1) =>
  new THREE.CylinderGeometry(r0, r1, y0 - y1, seg, 1, true).scale(1, 1, sz).translate(0, (y0 + y1) / 2, 0)
const merge = (list: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(list)
  if (!g) throw new Error('character geometry could not be merged')
  list.forEach((x) => x.dispose())
  return g
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z)

/** A flat strap between two points, e.g. a lanyard. */
function strap(a: THREE.Vector3, b: THREE.Vector3, width: number, thick: number) {
  const len = a.distanceTo(b)
  const g = new THREE.BoxGeometry(width, len, thick)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  g.applyQuaternion(q)
  const mid = a.clone().add(b).multiplyScalar(0.5)
  return g.translate(mid.x, mid.y, mid.z)
}

type Shell = {
  radius: [number, number, number]
  center: [number, number, number]
  /** How far down the shell reaches, as the polar angle from the crown. */
  reach: number
  /** The face opening: half-width, and the middle and half-height of its oval, in metres. */
  face: { halfWidth: number; centerY: number; halfHeight: number; straightSides?: boolean }
}

/**
 * A shell over the head, open at the bottom and with an oval left out at the front for the face. Built in rings, so the edge of the
 * opening is smooth. Normals follow the ellipsoid, so it shades as one round surface.
 */
function headShell({ radius: [rx_, ry, rz], center: [cx, cy, cz], reach, face }: Shell, rings = 10, around = 14): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const index: number[] = []
  // Extra rings just under the top of the opening keep its upper edge round.
  const thetas = Array.from({ length: rings + 1 }, (_, j) => (j / rings) * reach)
  for (const f of [0.97, 0.88, 0.7]) {
    const c = (face.centerY + face.halfHeight * f - cy) / ry
    if (Math.abs(c) < 1 && Math.acos(c) < reach) thetas.push(Math.acos(c))
  }
  thetas.sort((a, b) => a - b)
  for (let j = 0; j < thetas.length; j++) {
    const theta = thetas[j]
    const sinT = Math.sin(theta)
    const y = cy + ry * Math.cos(theta)
    const dy = (y - face.centerY) / face.halfHeight
    // A rounded, slightly squared oval. Below its middle the sides can run straight down, which leaves sideburns.
    const straight = face.straightSides === true && dy <= 0
    const open = dy < 1 && (dy > -1 || straight) && sinT > 1e-6
    const across = straight ? 1 : Math.pow(1 - Math.pow(Math.abs(dy), 2.6), 1 / 2.6)
    const half = open ? Math.asin(Math.min(1, (face.halfWidth * across) / (rx_ * sinT))) : 0
    for (let k = 0; k < around; k++) {
      const phi = -Math.PI / 2 + half + ((Math.PI * 2 - 2 * half) * k) / (around - 1)
      const ux = sinT * Math.cos(phi)
      const uy = Math.cos(theta)
      const uz = sinT * Math.sin(phi)
      positions.push(cx + rx_ * ux, cy + ry * uy, cz + rz * uz)
      const n = new THREE.Vector3(ux / rx_, uy / ry, uz / rz).normalize()
      normals.push(n.x, n.y, n.z)
    }
  }
  for (let j = 0; j < thetas.length - 1; j++) {
    for (let k = 0; k < around - 1; k++) {
      const a = j * around + k
      const b = a + 1
      const c = a + around
      const d = c + 1
      // Outward-facing winding: the rings run counter-clockwise seen from the crown.
      index.push(a, b, c, b, d, c)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2))
  g.setIndex(index)
  return g
}

// -- trunk. Chest and waist ellipsoids joined by a shoulder yoke, in spine coordinates (y = 0 at the waist).
function trunk(grow = 1, bottom = -0.02, skirt = 0) {
  const parts: THREE.BufferGeometry[] = [
    sph(0.165 * grow, 0.21, 0.108 * grow, 0, 0.27, 0, 12, 7),
    sph(0.147 * grow, 0.13, 0.102 * grow, 0, 0.05, 0, 10, 5),
    new THREE.CapsuleGeometry(0.052 * grow, 0.2, 1, 8).rotateZ(Math.PI / 2).scale(1, 1, 0.9).translate(0, 0.382, 0),
  ]
  if (bottom < -0.03) parts.push(tube(0.15 * grow, 0.152 * grow + skirt, 0.04, bottom, 12, 0.72))
  return parts
}

/** A sleeve: a tapered tube from the shoulder to y, with a rounded shoulder cap and elbow. */
function sleeve(r0: number, r1: number, len: number, cap = true) {
  const g: THREE.BufferGeometry[] = [tube(r0, r1, 0, -len, 8)]
  if (cap) g.push(sph(r0 * 1.05, r0 * 1.05, r0 * 1.05, 0, -0.005, 0, 6, 3))
  g.push(sph(r1 * 1.04, r1 * 1.04, r1 * 1.04, 0, -len, 0, 6, 3))
  return g
}

function shirtGeometry() {
  const g = trunk(1)
  // Pointed collar and a button line.
  g.push(box(0.055, 0.012, 0.075, -0.04, 0.43, -0.066))
  g.push(box(0.055, 0.012, 0.075, 0.04, 0.43, -0.066))
  g.push(box(0.014, 0.34, 0.01, 0, 0.23, -0.1075))
  g.push(new THREE.TorusGeometry(0.058, 0.014, 3, 8).rotateX(Math.PI / 2).scale(1, 1, 0.9).translate(0, 0.44, 0.0))
  return g
}

function geometries() {
  const entries: CharacterPartEntry[] = []
  const add = (part: CharacterPart, joint: Joint, geometry: THREE.BufferGeometry, castShadow = true) => entries.push({ part, joint, geometry, castShadow })
  const arms = (part: CharacterPart, upper: () => THREE.BufferGeometry[], fore: (() => THREE.BufferGeometry[]) | null) => {
    const u = merge(upper())
    add(part, 'upperArmL', u)
    add(part, 'upperArmR', u)
    if (fore) {
      const f = merge(fore())
      add(part, 'forearmL', f)
      add(part, 'forearmR', f)
    }
  }

  // Skin: head, jaw, ears, neck, forearms and hands.
  add('skin', 'head', merge([
    sph(0.092, 0.11, 0.098, 0, 0.135, 0.005, 12, 9),
    tube(0.043, 0.047, 0.11, -0.02, 8),
    sph(0.014, 0.026, 0.02, -0.091, 0.125, 0.012, 5, 3),
    sph(0.014, 0.026, 0.02, 0.091, 0.125, 0.012, 5, 3),
  ]))
  for (const side of [-1, 1] as const) {
    add('skin', side === -1 ? 'forearmL' : 'forearmR', merge([
      tube(0.039, 0.031, 0, -FOREARM, 8),
      sph(0.033, 0.047, 0.021, 0, -(FOREARM + 0.04), 0, 6, 4),
      sph(0.012, 0.027, 0.014, -side * 0.03, -(FOREARM + 0.02), -0.008, 4, 3),
    ]))
  }
  add('eyes', 'head', merge([sph(0.012, 0.014, 0.008, -0.034, 0.12, -0.089, 6, 4), sph(0.012, 0.014, 0.008, 0.034, 0.12, -0.089, 6, 4)]), false)

  // Hair and the hijab are shells over the head with an oval left open for the face. The hijab is bigger, reaches under the chin,
  // and has a drape over the neck and shoulders, so it reads as a wrapped covering and not as a hat.
  const hairShell = (grow: number, reach: number, tall = 1, halfWidth = 0.064) =>
    headShell({
      radius: [0.1 * grow, 0.118 * grow * tall, 0.106 * grow],
      center: [0, 0.14, 0],
      reach,
      face: { halfWidth, centerY: 0.105, halfHeight: 0.085, straightSides: true },
    }, 12, 13)
  add('hairShort', 'head', hairShell(1, 1.74), false)
  add('hairSide', 'head', merge([hairShell(1.02, 1.86, 1.05, 0.06), sph(0.07, 0.036, 0.06, 0.03, 0.222, -0.06, 8, 5).rotateZ(-0.3)]), false)
  add('hairBun', 'head', merge([hairShell(1, 1.7), sph(0.046, 0.042, 0.046, 0, 0.215, 0.1, 8, 6)]), false)
  add('hairLong', 'head', merge([
    hairShell(1.02, 1.95),
    new THREE.CylinderGeometry(0.11, 0.092, 0.32, 10, 1, true, -Math.PI * 0.67, Math.PI * 1.34).translate(0, 0.0, 0.01),
  ]), false)
  add('hijab', 'head', merge([
    headShell({ radius: [0.104, 0.128, 0.108], center: [0, 0.138, 0], reach: 2.9, face: { halfWidth: 0.064, centerY: 0.095, halfHeight: 0.09 } }, 11, 14),
    new THREE.CylinderGeometry(0.082, 0.17, 0.2, 12, 1, true).scale(1, 1, 0.8).translate(0, -0.045, 0.012),
  ]), false)

  // Tops. Sleeves are tubes with rounded joints; each cut has a different silhouette.
  add('shirt', 'spine', merge(shirtGeometry()))
  arms('shirt', () => sleeve(0.058, 0.052, UPPER_ARM), () => [tube(0.05, 0.05, 0, -0.07, 8), new THREE.TorusGeometry(0.05, 0.012, 3, 8).rotateX(Math.PI / 2).translate(0, -0.07, 0)])

  // Blazer: an open jacket shell that reaches below the waist, lapels, and a pale shirt panel in the opening.
  const gap = 0.7
  const open = (rx_: number, ry: number, rz: number, y: number, w: number, h: number) =>
    new THREE.SphereGeometry(1, w, h, Math.PI * 1.5 + gap / 2, Math.PI * 2 - gap).scale(rx_, ry, rz).translate(0, y, 0)
  add('blazer', 'spine', merge([
    open(0.176, 0.215, 0.116, 0.27, 12, 8),
    open(0.157, 0.14, 0.108, 0.04, 10, 6),
    new THREE.CylinderGeometry(0.156, 0.162, 0.2, 12, 1, true, Math.PI + gap / 2, Math.PI * 2 - gap).scale(1, 1, 0.74).translate(0, -0.02, 0),
    new THREE.CapsuleGeometry(0.056, 0.2, 2, 8).rotateZ(Math.PI / 2).scale(1, 1, 0.92).translate(0, 0.382, 0),
    box(0.045, 0.2, 0.014, -0.085, 0.3, -0.1),
    box(0.045, 0.2, 0.014, 0.085, 0.3, -0.1),
  ]))
  arms('blazer', () => sleeve(0.066, 0.057, UPPER_ARM), () => sleeve(0.057, 0.05, FOREARM - 0.02, false))
  add('blazerShirt', 'spine', merge([sph(0.15, 0.2, 0.105, 0, 0.28, 0, 8, 6)]))

  add('sweater', 'spine', merge([...trunk(1.1, -0.1, 0.01), new THREE.TorusGeometry(0.066, 0.022, 5, 10).rotateX(Math.PI / 2).translate(0, 0.44, -0.004)]))
  arms('sweater', () => sleeve(0.07, 0.061, UPPER_ARM), () => sleeve(0.061, 0.052, FOREARM - 0.03, false))

  add('tunic', 'spine', merge([...trunk(1.02), new THREE.TorusGeometry(0.058, 0.01, 4, 10).rotateX(Math.PI / 2).translate(0, 0.436, 0)]))
  add('tunic', 'hips', merge([tube(0.15, 0.185, 0.05, -0.16, 14, 0.78)]))
  arms('tunic', () => sleeve(0.06, 0.054, UPPER_ARM), () => sleeve(0.054, 0.058, FOREARM * 0.65, false))

  // Accent: a lanyard in the department colour, a loop at the neck, a V down the chest and a card.
  add('accent', 'spine', merge([
    new THREE.TorusGeometry(0.078, 0.007, 4, 12).rotateX(Math.PI / 2).scale(1, 1, 0.95).translate(0, 0.425, 0.005),
    strap(new THREE.Vector3(-0.065, 0.42, -0.08), new THREE.Vector3(0, 0.205, -0.128), 0.014, 0.006),
    strap(new THREE.Vector3(0.065, 0.42, -0.08), new THREE.Vector3(0, 0.205, -0.128), 0.014, 0.006),
    box(0.058, 0.078, 0.01, 0, 0.17, -0.128),
  ]), false)

  // Trousers, and shoes.
  add('trousers', 'hips', merge([sph(0.155, 0.115, 0.115, 0, -0.01, 0.005, 10, 6)]))
  const thighG = merge([tube(0.07, 0.054, 0, -THIGH, 8), sph(0.07, 0.07, 0.07, 0, 0, 0, 6, 4), sph(0.054, 0.054, 0.054, 0, -THIGH, 0, 6, 4)])
  add('trousers', 'thighL', thighG)
  add('trousers', 'thighR', thighG)
  const shinG = merge([tube(0.054, 0.042, 0, -(SHIN - 0.02), 8)])
  add('trousers', 'shinL', shinG)
  add('trousers', 'shinR', shinG)
  const shoeG = merge([sph(0.05, 0.036, 0.11, 0, -(SHIN + 0.034), -0.055, 8, 5)])
  add('shoes', 'shinL', shoeG)
  add('shoes', 'shinR', shoeG)

  // Error badge: a small exclamation mark above the head. Drawn only for the error action, see partVisible.
  add('badge', 'head', merge([
    new THREE.CapsuleGeometry(0.016, 0.04, 1, 5).translate(0, 0.335, 0),
    sph(0.017, 0.017, 0.017, 0, 0.285, 0, 5, 3),
  ]), false)
  return entries
}

/** Every piece of a character, built once and shared. A part may appear on several joints, as hands and sleeves do. */
export const CHARACTER_PARTS: CharacterPartEntry[] = geometries()
