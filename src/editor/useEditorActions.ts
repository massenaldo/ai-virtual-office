import type { RoomTemplateId } from '../layout/catalog'
import { addFurniture, addRoom, deleteFurniture, deleteRoom, duplicateFurniture, rotateFurniture, updateFurniture, updateRoom } from '../layout/operations'
import type { Furniture, FurnitureType, Room, Selection } from '../layout/types'
import type { ConfirmDialogProps } from './ConfirmDialog'
import { deletionPrompt } from './fields'
import type { LayoutEditor } from './useLayoutEditor'

export type DialogRequest = Omit<ConfirmDialogProps, 'open' | 'onClose'>

/**
 * Edit commands for the panels, scene and shortcuts. Operations that create ids run here, outside the reducer,
 * so StrictMode's double-invoked reducer can't generate two different ids for one click.
 */
export function useEditorActions({ state, dispatch }: LayoutEditor, openDialog: (d: DialogRequest) => void) {
  const { layout, selection } = state

  const anchor = () => {
    const roomId = selection?.kind === 'room' ? selection.id : layout.furniture.find((f) => f.id === selection?.id)?.roomId
    const room = layout.rooms.find((r) => r.id === roomId)
    return room ? { x: room.x, z: room.z } : { x: 0, z: 0 }
  }

  const deleteSelection = (target: NonNullable<Selection>) => dispatch({
    type: 'edit',
    update: (l) => (target.kind === 'room' ? deleteRoom(l, target.id) : deleteFurniture(l, target.id)),
    select: null,
  })

  return {
    select: (next: Selection) => dispatch({ type: 'select', selection: next }),
    addRoom: (template: RoomTemplateId) => {
      const added = addRoom(layout, template)
      dispatch({ type: 'edit', update: () => added.layout, select: { kind: 'room', id: added.id } })
    },
    addFurniture: (type: FurnitureType) => {
      const added = addFurniture(layout, type, anchor())
      dispatch({ type: 'edit', update: () => added.layout, select: { kind: 'furniture', id: added.id } })
    },
    duplicate: (id: string) => {
      const added = duplicateFurniture(layout, id)
      dispatch({ type: 'edit', update: () => added.layout, select: { kind: 'furniture', id: added.id } })
    },
    roomChange: (id: string, patch: Partial<Omit<Room, 'id'>>) => dispatch({ type: 'edit', update: (l) => updateRoom(l, id, patch) }),
    furnitureChange: (id: string, patch: Partial<Omit<Furniture, 'id' | 'type'>>) => dispatch({ type: 'edit', update: (l) => updateFurniture(l, id, patch) }),
    rotate: (id: string) => dispatch({ type: 'edit', update: (l) => rotateFurniture(l, id) }),
    requestDelete: () => {
      const prompt = deletionPrompt(layout, selection)
      if (!prompt || !selection) return
      const target = selection
      if (!prompt.needsConfirm) return deleteSelection(target)
      openDialog({ title: prompt.title, message: prompt.message, actions: [{ label: 'Delete', tone: 'danger', onClick: () => deleteSelection(target) }] })
    },
  }
}
