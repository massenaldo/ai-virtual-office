import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { characterLook, type CharacterLook } from './characterLook'
import {
  CHARACTER_PARTS, DONE_GESTURE_MS, HAND_POINT, HEAD_TOP_POINT, JOINTS, SOLE_POINT, characterAction, jointMatrices, partColor, partVisible,
  stepPose, targetPose, type CharacterAction, type CharacterPart, type Joint, type Pose,
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
