import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, CircleDot, MapPin, Orbit, Plus, RadioTower, ScanLine } from "lucide-react";
import { makeId } from "../domain/id";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { Selection } from "../domain/types";

type TreeItem = { key: string; depth: number; label: string; detail?: string; selection?: Selection; icon: React.ReactNode; header?: boolean };

export function ObjectTree() {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const scenario = useWorkbenchStore((state) => state.scenario);
  const spacecraft = useWorkbenchStore((state) => state.spacecraft);
  const sensors = useWorkbenchStore((state) => state.sensors);
  const stripeTreeKey = useWorkbenchStore((state) => state.stripes.map((item) => `${item.id}\u0000${item.name}\u0000${item.visible ? 1 : 0}`).join("\u0001"));
  const stripes = useMemo(() => useWorkbenchStore.getState().stripes.map((item) => ({ id: item.id, name: item.name, visible: item.visible })), [stripeTreeKey]);
  const groundAssets = useWorkbenchStore((state) => state.groundAssets);
  const tasks = useWorkbenchStore((state) => state.tasks);
  const selection = useWorkbenchStore((state) => state.selection);

  const items: TreeItem[] = [
    { key: "scenario-header", depth: 0, label: "场景", icon: <ChevronRight size={14} />, header: true },
    { key: scenario.id, depth: 1, label: scenario.name, detail: "时间与环境", selection: { kind: "scenario", id: scenario.id }, icon: <CircleDot size={14} /> },
    { key: "spacecraft-header", depth: 0, label: `卫星 (${spacecraft.length})`, icon: <ChevronRight size={14} />, header: true },
    ...spacecraft.map((item): TreeItem => ({ key: item.id, depth: 1, label: item.name, detail: { fast: "快速", planning: "规划", research: "研究" }[item.profile], selection: { kind: "spacecraft", id: item.id }, icon: <Orbit size={14} /> })),
    ...sensors.map((item): TreeItem => ({ key: item.id, depth: 2, label: item.name, detail: item.shape === "conical" ? "圆锥视场" : "矩形视场", icon: <RadioTower size={13} /> })),
    { key: "stripe-header", depth: 0, label: `条带 (${stripes.length})`, icon: <ChevronRight size={14} />, header: true },
    ...stripes.map((item): TreeItem => ({ key: item.id, depth: 1, label: item.name, detail: item.visible ? "显示" : "隐藏", selection: { kind: "stripe", id: item.id }, icon: <ScanLine size={14} /> })),
    { key: "ground-header", depth: 0, label: `地面对象 (${groundAssets.length})`, icon: <ChevronRight size={14} />, header: true },
    ...groundAssets.map((item): TreeItem => ({ key: item.id, depth: 1, label: item.name, detail: item.kind === "station" ? "地面站" : `目标区域 R ${item.radiusKm.toFixed(1)} km`, selection: { kind: "groundAsset", id: item.id }, icon: <MapPin size={14} /> })),
    { key: "task-header", depth: 0, label: `任务 (${tasks.length})`, icon: <ChevronRight size={14} />, header: true },
    ...tasks.map((item): TreeItem => ({ key: item.id, depth: 1, label: item.name, detail: item.status === "conflict" ? "冲突" : "有效", selection: { kind: "task", id: item.id }, icon: <ScanLine size={14} /> }))
  ];

  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => parentRef.current, estimateSize: () => 30, overscan: 8 });

  return (
    <aside className="object-panel">
      <div className="panel-title"><strong>对象浏览器</strong><div className="panel-actions"><button title="新增卫星" onClick={() => useWorkbenchStore.getState().addSpacecraft()}><Orbit size={13} /><Plus size={10} /></button><button title="新增目标区域" onClick={() => useWorkbenchStore.getState().addGroundAsset({ id: makeId("ground"), name: `目标 ${groundAssets.length + 1}`, kind: "target", visible: true, location: { lon: 116, lat: 40, heightKm: 0 }, minElevationDeg: 10, radiusKm: 25 })}><MapPin size={13} /><Plus size={10} /></button><span>{spacecraft.length + stripes.length + groundAssets.length + tasks.length}</span></div></div>
      <div className="object-tree" ref={parentRef}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index];
            const active = item.selection && selection?.kind === item.selection.kind && selection.id === item.selection.id;
            return (
              <button
                key={item.key}
                className={`tree-row${item.header ? " tree-header" : ""}${active ? " active" : ""}`}
                style={{ transform: `translateY(${row.start}px)`, paddingLeft: 10 + item.depth * 18 }}
                onClick={() => item.selection && useWorkbenchStore.getState().setSelection(item.selection)}
                disabled={item.header}
              >
                {item.icon}<span className="tree-label">{item.label}</span>{item.detail && <small>{item.detail}</small>}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
