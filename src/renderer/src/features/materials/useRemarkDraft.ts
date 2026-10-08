import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasMaterial, MaterialRemark, RemarkDraft } from "../../../../shared/contracts";
import { remarkPickable } from "./materialCardModel";
import {
  referenceCounts,
  remarkDraftWithoutLostMaterials,
  remarksByMaterial,
  type MaterialRemarkActions,
  type MaterialRemarking,
  type RemarkDraftState
} from "./materialRemarksModel";

const NO_REMARKS: MaterialRemark[] = [];

export interface RemarkDraftController {
  remarkDraft: RemarkDraftState | null;
  selectedRemarkId: string | null;
  materialNames: ReadonlyMap<string, string>;
  remarkActions: MaterialRemarkActions;
  remarkingFor(material: CanvasMaterial): MaterialRemarking;
}

export function useRemarkDraft({
  materials,
  remarks,
  onAddRemark,
  onRemarkAction
}: {
  materials: readonly CanvasMaterial[];
  remarks: readonly MaterialRemark[];
  onAddRemark(draft: RemarkDraft): Promise<boolean>;
  onRemarkAction(remarkId: string, action: "delete"): void;
}): RemarkDraftController {
  const [remarkDraft, setRemarkDraft] = useState<RemarkDraftState | null>(null);
  const [selectedRemarkId, setSelectedRemarkId] = useState<string | null>(null);
  const remarkDraftRef = useRef(remarkDraft);
  remarkDraftRef.current = remarkDraft;

  const materialNames = useMemo(() => new Map(materials.map((material) => [material.id, material.name])), [materials]);
  const remarksOfMaterial = useMemo(() => remarksByMaterial(remarks), [remarks]);
  const referencesToMaterial = useMemo(() => referenceCounts(remarks), [remarks]);
  const selectedReference = selectedRemarkId ? remarks.find((remark) => remark.id === selectedRemarkId)?.reference ?? null : null;

  const remarkActions = useMemo<MaterialRemarkActions>(() => ({
    start: (materialId, anchor) => {
      setSelectedRemarkId(null);
      setRemarkDraft({ materialId, anchor, reference: null, picking: false });
    },
    draw: (materialId, anchor) => setRemarkDraft((current) => {
      if (!current) return current;
      if (current.picking) {
        return materialId === current.materialId ? current : { ...current, reference: { materialId, anchor }, picking: false };
      }
      return current.materialId === materialId ? { ...current, anchor } : current;
    }),
    cancel: () => setRemarkDraft(null),
    pickReference: () => setRemarkDraft((current) => current ? { ...current, picking: true } : current),
    clearReference: () => setRemarkDraft((current) => current ? { ...current, reference: null, picking: false } : current),
    save: async (text) => {
      const draft = remarkDraftRef.current;
      if (!draft?.anchor) return false;
      const saved = await onAddRemark({ materialId: draft.materialId, anchor: draft.anchor, reference: draft.reference, text });
      if (saved && remarkDraftRef.current === draft) setRemarkDraft(null);
      return saved;
    },
    select: (remarkId) => setSelectedRemarkId(remarkId),
    act: (remarkId, action) => onRemarkAction(remarkId, action)
  }), [onAddRemark, onRemarkAction]);

  useEffect(() => {
    if (!remarkDraft) return;
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof Element && target.closest("textarea, input, select, [contenteditable='true']")) return;
      event.preventDefault();
      setRemarkDraft((current) => current?.picking ? { ...current, picking: false } : null);
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [remarkDraft]);

  useEffect(() => {
    if (remarkDraft) {
      const present = new Set(materials.map((material) => material.id));
      const kept = remarkDraftWithoutLostMaterials(remarkDraft, present);
      if (kept !== remarkDraft) setRemarkDraft(kept);
    }
    if (selectedRemarkId && !remarks.some((remark) => remark.id === selectedRemarkId)) setSelectedRemarkId(null);
  }, [materials, remarkDraft, remarks, selectedRemarkId]);

  const remarkingFor = (material: CanvasMaterial): MaterialRemarking => {
    const draft = remarkDraft;
    const isSource = draft?.materialId === material.id;
    const mode = !draft ? "view" : isSource ? "draw" : draft.picking && remarkPickable(material) ? "pick" : "view";
    return {
      remarks: remarksOfMaterial.get(material.id) ?? NO_REMARKS,
      referencedBy: referencesToMaterial.get(material.id) ?? 0,
      mode,
      draftAnchor: isSource ? draft.anchor : null,
      referenceAnchor: draft?.reference?.materialId === material.id
        ? draft.reference.anchor
        : !draft && selectedReference?.materialId === material.id ? selectedReference.anchor : null,
      selectedRemarkId
    };
  };

  return { remarkDraft, selectedRemarkId, materialNames, remarkActions, remarkingFor };
}
