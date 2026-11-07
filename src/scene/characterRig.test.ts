import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { characterLook, type CharacterLook } from './characterLook'
import {
  CHARACTER_PARTS, DONE_GESTURE_MS, HAND_POINT, HEAD_TOP_POINT, JOINTS, SOLE_POINT, characterAction, jointMatrices, partColor, partMatrix, partVisible,
  chooseAction, easeRotation, gaitAfter, stepPose, targetPose, type CharacterAction, type CharacterPart, type Joint, type Pose,
} from './characterRig'

const matrices = (pose: Pose, body: CharacterLook['body'] = 'man') => {
  const out = JOINTS.map(() => new THREE.Matrix4())
  jointMatrices(pose, out, body)
  return out
}
/** The world position of a point on a joint, for a pose. */
const at = (pose: Pose, joint: Joint, point: THREE.Vector3, body: CharacterLook['body'] = 'man') =>
  point.clone().applyMatrix4(matrices(pose, body)[JOINTS.indexOf(joint)])
const seated = (action: CharacterAction) => targetPose(action, true, 0, 0)
const origin = new THREE.Vector3()
const triangles = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3
const ACTIONS: CharacterAction[] = ['idle', 'typing', 'thinking', 'waiting', 'error', 'done']

describe('characterAction', () => {
  it('maps each status', () => {
    expect(characterAction('working', null, 0)).toBe('typing')
    expect(characterAction('thinking', null, 0)).toBe('thinking')
    expect(characterAction('waiting', null, 0)).toBe('waiting')
    expect(characterAction('error', null, 0)).toBe('error')
    expect(characterAction('idle', null, 0)).toBe('idle')
  })
  it('idle within 4 s of doneAt is done', () => expect(characterAction('idle', 1000, 4999)).toBe('done'))
  it('at 4 s it is idle', () => {
    expect(DONE_GESTURE_MS).toBe(4000)
    expect(characterAction('idle', 1000, 5000)).toBe('idle')
  })
  it('a future, invalid or old doneAt is idle', () => {
    expect(characterAction('idle', 9000, 1000)).toBe('idle')
    expect(characterAction('idle', Number.NaN, 1000)).toBe('idle')
    expect(characterAction('idle', 1000, Number.NaN)).toBe('idle')
    expect(characterAction('idle', 1000, 3_600_000)).toBe('idle')
  })
  it('a status other than idle beats doneAt', () => expect(characterAction('error', 1000, 1500)).toBe('error'))
})

describe('seated body', () => {
  for (const body of ['man', 'woman'] as const) {
    it(`${body}: feet are on the floor`, () => {
      for (const a of ACTIONS) for (const side of ['shinL', 'shinR'] as const) expect(Math.abs(at(seated(a), side, SOLE_POINT, body).y)).toBeLessThanOrEqual(0.06)
    })
    it(`${body}: hips are at the chair seat`, () => {
      for (const a of ACTIONS) expect(at(seated(a), 'hips', origin, body).y).toBeGreaterThanOrEqual(0.48)
      for (const a of ACTIONS) expect(at(seated(a), 'hips', origin, body).y).toBeLessThanOrEqual(0.6)
    })
    it(`${body}: the head top is under the label`, () => {
      for (const a of ['idle', 'typing', 'thinking', 'waiting', 'done'] as const) {
        const top = at(seated(a), 'head', HEAD_TOP_POINT, body).y
        expect(top).toBeGreaterThanOrEqual(1.1)
        expect(top).toBeLessThanOrEqual(1.38)
      }
    })
    it(`${body}: typing puts both hands at the keyboard`, () => {
      const p = seated('typing')
      for (const [joint, x] of [['forearmL', -0.1], ['forearmR', 0.1]] as const) {
        expect(at(p, joint, HAND_POINT, body).distanceTo(new THREE.Vector3(x, 0.78, -0.44))).toBeLessThan(0.15)
      }
    })
  }
  it('idle hands rest in the lap, over the thighs and in front of the chair back', () => {
    for (const joint of ['forearmL', 'forearmR'] as const) {
      const hand = at(seated('idle'), joint, HAND_POINT)
      expect(hand.y).toBeGreaterThan(0.6)
      expect(hand.y).toBeLessThan(0.85)
      expect(hand.z).toBeLessThan(-0.1)
    }
  })
  it('thinking puts the right hand near the chin', () => {
    const p = seated('thinking')
    const chin = at(p, 'head', new THREE.Vector3(0, 0.05, -0.1))
    expect(at(p, 'forearmR', HAND_POINT).distanceTo(chin)).toBeLessThan(0.2)
  })
  it('waiting raises one hand above the head', () => {
    const p = seated('waiting')
    expect(at(p, 'forearmR', HAND_POINT).y).toBeGreaterThan(at(p, 'head', HEAD_TOP_POINT).y + 0.05)
  })
  it('done raises the hand above the shoulder and idle does not', () => {
    const shoulder = (p: Pose) => at(p, 'upperArmR', origin).y
    expect(at(seated('done'), 'forearmR', HAND_POINT).y).toBeGreaterThan(shoulder(seated('done')))
    expect(at(seated('idle'), 'forearmR', HAND_POINT).y).toBeLessThan(shoulder(seated('idle')))
  })
  it('error drops the head below its idle height', () => {
    expect(at(seated('error'), 'head', HEAD_TOP_POINT).y).toBeLessThan(at(seated('idle'), 'head', HEAD_TOP_POINT).y - 0.1)
  })
  it('the pose moves over time and characters with different phases differ', () => {
    expect(targetPose('typing', true, 0.1, 0).elbowL).not.toBe(targetPose('typing', true, 0.2, 0).elbowL)
    expect(targetPose('idle', true, 1, 0).spine).not.toBe(targetPose('idle', true, 1, 0.3).spine)
  })
  it('bad time or phase gives a finite pose', () => {
    for (const v of Object.values(targetPose('typing', true, Number.NaN, Infinity))) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('standing body', () => {
  it('head top is at most 1.85 and the feet are on the floor', () => {
    for (const a of ACTIONS) {
      const p = targetPose(a, false, 0.7, 0.2)
      expect(at(p, 'head', HEAD_TOP_POINT).y).toBeLessThanOrEqual(1.85)
      expect(Math.abs(at(p, 'shinL', SOLE_POINT).y)).toBeLessThanOrEqual(0.06)
    }
  })
})

describe('stepPose', () => {
  const from = seated('idle')
  const to = seated('error')
  it('moves toward the target without passing it', () => {
    const { pose, settled } = stepPose(from, to, 0.05)
    expect(settled).toBe(false)
    for (const k of Object.keys(to) as (keyof Pose)[]) {
      const lo = Math.min(from[k], to[k])
      const hi = Math.max(from[k], to[k])
      expect(pose[k]).toBeGreaterThanOrEqual(lo - 1e-9)
      expect(pose[k]).toBeLessThanOrEqual(hi + 1e-9)
    }
    expect(pose.spine).toBeGreaterThan(from.spine)
  })
  it('a one-hour step lands exactly on the target and is settled', () => {
    const r = stepPose(from, to, 3600)
    expect(r.pose).toEqual(to)
    expect(r.settled).toBe(true)
  })
  it('is settled when nothing moves', () => expect(stepPose(to, to, 0.016).settled).toBe(true))
  it('negative or invalid steps do not move or break the pose', () => {
    for (const dt of [-1, Number.NaN]) {
      const r = stepPose(from, to, dt)
      expect(r.settled).toBe(false)
      expect(r.pose.spine).toBeCloseTo(from.spine, 9)
    }
  })
})

describe('parts', () => {
  const looks = Array.from({ length: 400 }, (_, i) => characterLook(`agent-${i}`))
  const partNames = new Set(CHARACTER_PARTS.map((e) => e.part))
  const used = (look: CharacterLook, accent = '#e4572e') =>
    CHARACTER_PARTS.filter((e) => partColor(e.part, look, accent) !== null)

  it('a whole character is at most 2500 triangles and there are at most 20 parts', () => {
    expect(partNames.size).toBeLessThanOrEqual(20)
    for (const look of looks) {
      const total = used(look).reduce((n, e) => n + triangles(e.geometry), 0)
      expect(total).toBeLessThanOrEqual(2500)
    }
  })
  it('every entry uses a known joint and geometry with normals', () => {
    for (const e of CHARACTER_PARTS) {
      expect(JOINTS).toContain(e.joint)
      expect(e.geometry.attributes.position.count).toBeGreaterThan(0)
      expect(e.geometry.attributes.normal).toBeDefined()
    }
  })
  it('every look has exactly one hair or hijab part, and the accent part uses the accent colour', () => {
    const hairParts: CharacterPart[] = ['hairShort', 'hairSide', 'hairBun', 'hairLong', 'hijab']
    for (const look of looks) {
      expect(hairParts.filter((p) => partColor(p, look, '#112233') !== null)).toHaveLength(1)
      expect(partColor('accent', look, '#112233')).toBe('#112233')
    }
  })
  it('every look has exactly one clothing cut, and every cut part exists', () => {
    const cuts: CharacterPart[] = ['shirt', 'blazer', 'sweater', 'tunic']
    for (const look of looks) expect(cuts.filter((p) => partColor(p, look, '#fff') !== null && p === look.cut)).toHaveLength(1)
    for (const p of [...cuts, 'accent', 'skin', 'eyes', 'trousers', 'shoes'] as CharacterPart[]) expect(partNames.has(p)).toBe(true)
  })
  it('the accent colour shows on every cut', () => {
    for (const cut of ['shirt', 'blazer', 'sweater', 'tunic'] as const) {
      const look = { ...characterLook('x'), cut }
      expect(used(look).some((e) => e.part === 'accent')).toBe(true)
    }
  })
  it('cuts have different shapes', () => {
    const size = (p: CharacterPart) => CHARACTER_PARTS.filter((e) => e.part === p).map((e) => `${e.joint}:${triangles(e.geometry)}`).join(',')
    expect(new Set(['shirt', 'blazer', 'sweater', 'tunic'].map((p) => size(p as CharacterPart))).size).toBe(4)
  })
  it('the badge part is only drawn in the error action', () => {
    for (const a of ACTIONS) expect(partVisible('badge', a)).toBe(a === 'error')
    for (const a of ACTIONS) expect(partVisible('skin', a)).toBe(true)
  })
  it('the badge shows in any action when the status is error', () => {
    for (const a of [...ACTIONS, ...MORE_ACTIONS]) {
      expect(partVisible('badge', a, 'error')).toBe(true)
      expect(partVisible('badge', a, 'working')).toBe(a === 'error')
    }
  })
  it('the badge stays upright above a standing and a walking head', () => {
    for (const pose of [targetPose('walk', false, 0, 0, 1.3), targetPose('pray', false, 0, 0)]) {
      const head = matrices(pose)[JOINTS.indexOf('head')]
      const badge = partMatrix('badge', head, new THREE.Matrix4())
      expect(new THREE.Vector3(0, 1, 0).transformDirection(badge).y).toBeCloseTo(1)
    }
  })
  it('the error badge stays upright and above a slumped head', () => {
    const head = matrices(seated('error'))[JOINTS.indexOf('head')]
    const badge = partMatrix('badge', head, new THREE.Matrix4())
    const up = new THREE.Vector3(0, 1, 0).transformDirection(badge)
    expect(up.y).toBeCloseTo(1)
    expect(new THREE.Vector3().setFromMatrixPosition(badge).distanceTo(new THREE.Vector3().setFromMatrixPosition(head))).toBeCloseTo(0)
    const geometry = CHARACTER_PARTS.find((e) => e.part === 'badge')!.geometry
    geometry.computeBoundingBox()
    const lowest = geometry.boundingBox!.min.clone().setX(0).setZ(0).applyMatrix4(badge).y
    expect(lowest).toBeGreaterThan(at(seated('error'), 'head', HEAD_TOP_POINT).y)
  })
  it('every other part follows its joint exactly', () => {
    const head = matrices(seated('error'))[JOINTS.indexOf('head')]
    expect(partMatrix('skin', head, new THREE.Matrix4()).equals(head)).toBe(true)
  })
  it('hijab covers more of the head and neck than hair', () => {
    const box = (p: CharacterPart) => new THREE.Box3().setFromObject(new THREE.Mesh(CHARACTER_PARTS.find((e) => e.part === p)!.geometry))
    const hijab = box('hijab')
    expect(hijab.min.y).toBeLessThan(-0.1) // drapes over neck and shoulders
    expect(hijab.max.y).toBeGreaterThan(box('hairShort').max.y)
  })
  it('colours are hex strings', () => {
    for (const look of looks.slice(0, 50)) for (const p of partNames) {
      const c = partColor(p, look, '#e4572e')
      if (c !== null) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
  it('reads only its arguments: no look field beyond the colours and styles', () => {
    expect(partColor.length).toBe(3)
    expect(characterAction.length).toBe(3)
  })
})

const MORE_ACTIONS: CharacterAction[] = ['walk', 'coffee', 'eat', 'chat', 'pray']
const footY = (p: Pose, joint: 'shinL' | 'shinR') => at(p, joint, SOLE_POINT).y
const handOf = (p: Pose, joint: 'forearmL' | 'forearmR') => at(p, joint, HAND_POINT)

describe('walking', () => {
  const cycle = Array.from({ length: 24 }, (_, i) => targetPose('walk', false, 0, 0, (i / 24) * Math.PI * 2))
  it('swings an arm opposite to the leg on its side', () => {
    for (const p of cycle) {
      expect(Math.sign(p.armL) * Math.sign(p.thighL)).toBeLessThanOrEqual(0)
      expect(Math.sign(p.armR) * Math.sign(p.thighR)).toBeLessThanOrEqual(0)
    }
    expect(Math.max(...cycle.map((p) => p.thighL))).toBeGreaterThan(0.3)
    expect(Math.min(...cycle.map((p) => p.thighL))).toBeLessThan(-0.3)
  })
  it('keeps the feet near the floor and the head under 1.85', () => {
    for (const p of cycle) {
      expect(footY(p, 'shinL')).toBeGreaterThan(-0.04)
      expect(footY(p, 'shinR')).toBeGreaterThan(-0.04)
      expect(Math.min(footY(p, 'shinL'), footY(p, 'shinR'))).toBeLessThan(0.04)
      expect(Math.max(footY(p, 'shinL'), footY(p, 'shinR'))).toBeLessThan(0.2)
      expect(at(p, 'head', HEAD_TOP_POINT).y).toBeLessThanOrEqual(1.85)
    }
  })
  it('does not bob the hips', () => {
    expect(new Set(cycle.map((p) => p.hipsY)).size).toBe(1)
  })
  it('depends on the distance walked and not on the time', () => {
    expect(targetPose('walk', false, 0, 0.3, 2)).toEqual(targetPose('walk', false, 99, 0.3, 2))
    expect(targetPose('walk', false, 0, 0, 0)).not.toEqual(targetPose('walk', false, 0, 0, 1.5))
  })
  it('gaitAfter advances by distance, wraps, and ignores bad values', () => {
    const a = gaitAfter(0, 0.65)
    expect(a).toBeGreaterThan(0)
    expect(gaitAfter(a, 0.65)).toBeCloseTo((a * 2) % (Math.PI * 2))
    expect(gaitAfter(1, 0)).toBe(1)
    expect(gaitAfter(1, Number.NaN)).toBe(1)
    expect(gaitAfter(Number.NaN, 1)).toBeGreaterThanOrEqual(0)
    expect(gaitAfter(1, 1000)).toBeLessThan(Math.PI * 2)
  })
})

describe('praying', () => {
  const sample = [0, 1.3, 4.1, 9.9].map((t) => targetPose('pray', false, t, 0.4))
  it('stands upright with the head only slightly lowered, never bowing', () => {
    for (const p of sample) {
      expect(Math.abs(p.spine)).toBeLessThan(0.1)
      expect(p.headPitch).toBeGreaterThan(0)
      expect(p.headPitch).toBeLessThan(0.3)
    }
  })
  it('keeps the hands low and relaxed at the sides, and the feet on the floor', () => {
    for (const p of sample) {
      for (const j of ['forearmL', 'forearmR'] as const) expect(handOf(p, j).y).toBeLessThan(0.95)
      expect(Math.abs(footY(p, 'shinL'))).toBeLessThanOrEqual(0.06)
      expect(Math.abs(footY(p, 'shinR'))).toBeLessThanOrEqual(0.06)
    }
  })
  it('only breathes: arms and legs do not move over time', () => {
    const a = targetPose('pray', false, 0, 0.4)
    const b = targetPose('pray', false, 3, 0.4)
    for (const k of ['armL', 'armR', 'elbowL', 'elbowR', 'thighR', 'kneeL', 'kneeR', 'hipsY'] as const) expect(b[k]).toBe(a[k])
    expect(Math.abs(b.spine - a.spine)).toBeLessThan(0.03)
    expect(Math.abs(b.armL - a.armL)).toBeLessThan(0.03)
  })
})

describe('coffee, chat and eat', () => {
  it('coffee holds one forearm up in front, the other hand low', () => {
    const p = targetPose('coffee', false, 0.5, 0.1)
    const hands = [handOf(p, 'forearmL'), handOf(p, 'forearmR')]
    const high = hands.find((h) => h.y > 1.0)!
    expect(high).toBeDefined()
    expect(high.z).toBeLessThan(-0.1)
    expect(hands.filter((h) => h.y < 0.95)).toHaveLength(1)
    expect(Math.abs(footY(p, 'shinL'))).toBeLessThanOrEqual(0.06)
  })
  it('chat keeps the hands within reach, below the chin, with the feet on the floor', () => {
    for (const t of [0, 0.7, 1.9]) {
      const p = targetPose('chat', false, t, 0.1)
      for (const j of ['forearmL', 'forearmR'] as const) {
        const h = handOf(p, j)
        expect(h.y).toBeGreaterThan(0.6)
        expect(h.y).toBeLessThan(1.45)
      }
      expect(Math.abs(footY(p, 'shinR'))).toBeLessThanOrEqual(0.06)
      expect(at(p, 'head', HEAD_TOP_POINT).y).toBeLessThanOrEqual(1.85)
    }
  })
  it('eat, seated, puts both hands at the table in front of the chair', () => {
    const p = targetPose('eat', true, 0.4, 0.2)
    for (const j of ['forearmL', 'forearmR'] as const) {
      const h = handOf(p, j)
      expect(h.z).toBeLessThan(-0.25)
      expect(h.y).toBeGreaterThan(0.6)
      expect(h.y).toBeLessThan(0.95)
    }
    expect(Math.abs(footY(p, 'shinL') - footY(seated('idle'), 'shinL'))).toBeLessThan(0.01)
  })
  it('every new action gives a finite pose for bad time and phase', () => {
    for (const a of MORE_ACTIONS) for (const s of [true, false]) {
      const p = targetPose(a, s, Number.NaN, Number.NaN, Number.NaN)
      for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('chooseAction', () => {
  const base = { status: 'idle' as const, doneAt: null, nowMs: 1000, pose: 'sit' as const, activity: 'idle' as const, atDesk: true }
  it('a task status acts only when the character is at its desk', () => {
    expect(chooseAction({ ...base, status: 'working' })).toBe('typing')
    expect(chooseAction({ ...base, status: 'thinking', pose: 'stand' })).toBe('thinking')
    expect(chooseAction({ ...base, status: 'working', pose: 'walk', atDesk: false })).toBe('walk')
    expect(chooseAction({ ...base, status: 'working', pose: 'stand', activity: 'pray', atDesk: false })).toBe('pray')
  })
  it('walk, then the activity, then done, then idle', () => {
    expect(chooseAction({ ...base, pose: 'walk', atDesk: false, activity: 'coffee' })).toBe('walk')
    for (const activity of ['coffee', 'eat', 'chat', 'pray'] as const) expect(chooseAction({ ...base, pose: 'stand', atDesk: false, activity })).toBe(activity)
    expect(chooseAction({ ...base, doneAt: 500 })).toBe('done')
    expect(chooseAction({ ...base, doneAt: 500, pose: 'stand', atDesk: false, activity: 'chat' })).toBe('chat')
    expect(chooseAction(base)).toBe('idle')
  })
})

describe('easeRotation', () => {
  it('turns the short way round', () => {
    expect(easeRotation(350, 10, 0.05)).toBeGreaterThan(350)
    expect(easeRotation(10, 350, 0.05)).toBeLessThan(10)
  })
  it('eases and does not snap for an ordinary turn, and never overshoots', () => {
    const r = easeRotation(0, 90, 0.016)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(45)
    let cur = 0
    for (let i = 0; i < 100; i++) cur = easeRotation(cur, 90, 0.016)
    expect(cur).toBeCloseTo(90, 0)
    expect(cur).toBeLessThanOrEqual(90.0001)
  })
  it('a long gap lands on the target, and bad input is safe', () => {
    expect(easeRotation(0, 170, 30)).toBe(170)
    expect(easeRotation(Number.NaN, 20, 0.016)).toBe(20)
    expect(easeRotation(5, 20, Number.NaN)).toBe(5)
  })
})
