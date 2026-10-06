import type {
  CanvasMaterial,
  LocaleId,
  MaterialHandoff,
  MaterialRemark,
  SessionBounds
} from "../../../../shared/contracts";
import { latestHandoff, type MaterialRemarkActions, type RemarkDraftState } from "./materialRemarksModel";
import { RemarkDrawHint, RemarkEditor } from "./RemarkEditor";
import { RemarkPanel, type RemarkAction } from "./RemarkPanel";

export function RemarkPopover({
  locale,
  material,
  rect,
  remarkDraft,
  selectedRemark,
  handoffs,
  materialNames,
  remarkActions
}: {
  locale: LocaleId;
  material: CanvasMaterial;
  rect: SessionBounds | null;
  remarkDraft: RemarkDraftState | null;
  selectedRemark: MaterialRemark | null;
  handoffs: readonly MaterialHandoff[];
  materialNames: ReadonlyMap<string, string>;
  remarkActions: MaterialRemarkActions;
}): React.JSX.Element {
  return (
    <div
      className={`material-remark-popover ${remarkDraft?.picking ? "material-remark-popover--hidden" : ""}`}
      data-interactive="true"
      data-canvas-wheel-priority="local"
      style={rect ? { left: rect.position.x, top: rect.position.y, width: rect.size.width } : undefined}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {remarkDraft && !remarkDraft.anchor && (
        <RemarkDrawHint
          locale={locale}
          kind={material.kind}
          onWhole={() => remarkActions.draw(remarkDraft.materialId, { kind: "whole" })}
          onCancel={remarkActions.cancel}
        />
      )}
      {remarkDraft?.anchor && (
        <RemarkEditor
          key={remarkDraft.materialId}
          locale={locale}
          anchor={remarkDraft.anchor}
          referenceName={remarkDraft.reference ? materialNames.get(remarkDraft.reference.materialId) ?? null : null}
          picking={remarkDraft.picking}
          onPickReference={remarkActions.pickReference}
          onClearReference={remarkActions.clearReference}
          onSave={remarkActions.save}
          onCancel={remarkActions.cancel}
        />
      )}
      {!remarkDraft && selectedRemark && (
        <RemarkPanel
          locale={locale}
          remark={selectedRemark}
          handoff={latestHandoff(handoffs, selectedRemark)}
          referenceName={selectedRemark.reference ? materialNames.get(selectedRemark.reference.materialId) ?? null : null}
          stale={material.versions.some((version) => version.id === selectedRemark.target.versionId && !version.current)}
          onAction={(action: RemarkAction) => remarkActions.act(selectedRemark.id, action)}
          onClose={() => remarkActions.select(null)}
        />
      )}
    </div>
  );
}
