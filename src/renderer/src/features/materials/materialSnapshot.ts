import type { CanvasMaterial, MaterialsSnapshot, SessionBounds } from "../../../../shared/contracts.ts";

export const EMPTY_MATERIALS_SNAPSHOT: MaterialsSnapshot = {
  revision: 0,
  materials: [],
  remarks: [],
  storage: { usedBytes: 0, limitBytes: 0 }
};

export function acceptMaterialsSnapshot(current: MaterialsSnapshot, next: MaterialsSnapshot): MaterialsSnapshot {
  if (next.revision < current.revision) return current;
  const previous = new Map(current.materials.map((material) => [material.id, material]));
  let shared: CanvasMaterial[] | null = null;
  for (let index = 0; index < next.materials.length; index += 1) {
    const material = next.materials[index];
    const before = previous.get(material.id);
    if (!before || before.position === material.position || !sameBounds(before, material)) continue;
    (shared ??= [...next.materials])[index] = { ...material, position: before.position, size: before.size };
  }
  return shared ? { ...next, materials: shared } : next;
}

export function withPendingBounds(
  materials: readonly CanvasMaterial[],
  pending: Map<string, SessionBounds>
): CanvasMaterial[] {
  const present = new Set(materials.map((material) => material.id));
  for (const id of [...pending.keys()]) if (!present.has(id)) pending.delete(id);
  return materials.map((material) => {
    const bounds = pending.get(material.id);
    if (!bounds) return material;
    if (sameBounds(material, bounds)) {
      pending.delete(material.id);
      return material;
    }
    return { ...material, position: { ...bounds.position }, size: { ...bounds.size } };
  });
}

function sameBounds(left: SessionBounds, right: SessionBounds): boolean {
  return left.position.x === right.position.x
    && left.position.y === right.position.y
    && left.size.width === right.size.width
    && left.size.height === right.size.height;
}
