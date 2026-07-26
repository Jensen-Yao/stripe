import { useEffect, useRef } from "react";
import { Inspector } from "./components/Inspector";
import { ObjectTree } from "./components/ObjectTree";
import { Timeline } from "./components/Timeline";
import { TopToolbar } from "./components/TopToolbar";
import { MapWorkbench } from "./map/MapWorkbench";
import { useWorkbenchStore } from "./store/workbenchStore";

export function App() {
  const status = useWorkbenchStore((state) => state.status);
  const isPlaying = useWorkbenchStore((state) => state.isPlaying);
  const lastTickRef = useRef(performance.now());

  useEffect(() => {
    window.stripeApi.updateScienceData().then((result) => {
      if (result.updated) useWorkbenchStore.getState().setStatus(`科学数据已更新：${result.version ?? "最新版本"}`);
    }).catch(() => useWorkbenchStore.getState().setStatus("科学数据更新失败，继续使用本地缓存"));
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let lastCommit = 0;
    let pendingElapsed = 0;
    const tick = (time: number) => {
      const elapsed = time - lastTickRef.current;
      lastTickRef.current = time;
      pendingElapsed += elapsed;
      if (time - lastCommit >= 33) {
        lastCommit = time;
        const state = useWorkbenchStore.getState();
        const current = new Date(state.scenario.currentTime).getTime();
        const end = new Date(state.scenario.endTime).getTime();
        const next = current + pendingElapsed * state.scenario.playbackSpeed;
        pendingElapsed = 0;
        if (next >= end) {
          state.setCurrentTime(state.scenario.endTime);
          state.setPlaying(false);
          return;
        }
        state.setCurrentTime(new Date(next).toISOString());
      }
      frame = requestAnimationFrame(tick);
    };
    lastTickRef.current = performance.now();
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useWorkbenchStore.getState();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void window.stripeApi.saveProject(state.snapshot(), state.projectPath).then((result) => !result.canceled && state.markSaved(result.filePath));
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? state.redo() : state.undo();
      } else if (event.key === "Delete") state.deleteSelected();
      else if (event.key === "Escape") state.setToolMode("select");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const saveProject = async (saveAs: boolean) => {
      const state = useWorkbenchStore.getState();
      const result = await window.stripeApi.saveProject(state.snapshot(), saveAs ? undefined : state.projectPath);
      if (!result.canceled) state.markSaved(result.filePath);
    };
    const openProject = async () => {
      const state = useWorkbenchStore.getState();
      if (state.dirty && !window.confirm("当前项目有未保存修改，仍要打开其他项目吗？")) return;
      const result = await window.stripeApi.openProject();
      if (!result.canceled && result.snapshot) useWorkbenchStore.getState().hydrate(result.snapshot, result.filePath);
    };
    const onNativeCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      const state = useWorkbenchStore.getState();
      if (command === "project:new") {
        if (!state.dirty || window.confirm("当前项目有未保存修改，仍要新建项目吗？")) state.resetProject();
      } else if (command === "project:open") void openProject();
      else if (command === "project:save") void saveProject(false);
      else if (command === "project:saveAs") void saveProject(true);
      else if (command === "edit:undo") state.undo();
      else if (command === "edit:redo") state.redo();
      else if (command === "edit:delete") state.deleteSelected();
      else if (command === "edit:paste") document.execCommand("paste");
      else if (command === "view:2d") state.setViewMode("2d");
      else if (command === "view:3d") state.setViewMode("3d");
    };
    window.addEventListener("stripe:native-command", onNativeCommand);
    return () => window.removeEventListener("stripe:native-command", onNativeCommand);
  }, []);

  return (
    <main className="app-shell">
      <TopToolbar />
      <div className="workspace-grid">
        <ObjectTree />
        <section className="viewport-panel">
          <MapWorkbench />
        </section>
        <Inspector />
        <Timeline />
      </div>
      <footer className="status-bar"><span>{status}</span><span>WGS84 · SGP4/SDP4 · 工程规划级</span></footer>
    </main>
  );
}
