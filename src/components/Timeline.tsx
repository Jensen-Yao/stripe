import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useWorkbenchStore } from "../store/workbenchStore";

export function Timeline() {
  const scenario = useWorkbenchStore((state) => state.scenario);
  const tasks = useWorkbenchStore((state) => state.tasks);
  const accessWindows = useWorkbenchStore((state) => state.accessWindows);
  const start = new Date(scenario.startTime).getTime();
  const end = new Date(scenario.endTime).getTime();
  const current = new Date(scenario.currentTime).getTime();
  const totalMinutes = Math.max(1, (end - start) / 60000);
  const offsetMinutes = Math.min(totalMinutes, Math.max(0, (current - start) / 60000));

  return (
    <section className="timeline-panel">
      <div className="timeline-toolbar">
        <strong>场景时间线</strong>
        <input
          type="range"
          min={0}
          max={totalMinutes}
          step={0.05}
          value={offsetMinutes}
          onChange={(event) => useWorkbenchStore.getState().setCurrentTime(new Date(start + Number(event.target.value) * 60000).toISOString())}
        />
        <time>{new Date(scenario.currentTime).toLocaleString("zh-CN", { hour12: false })}</time>
        <span>{scenario.playbackSpeed}×</span>
      </div>
      <div className="timeline-content">
        <div className="timeline-lane">
          <span className="lane-label">访问窗口</span>
          <div className="lane-track">
            {accessWindows.map((window) => {
              const left = ((new Date(window.startTime).getTime() - start) / Math.max(1, end - start)) * 100;
              const width = (window.durationSeconds * 1000 / Math.max(1, end - start)) * 100;
              return <button key={window.id} className="access-segment" style={{ left: `${left}%`, width: `${Math.max(0.35, width)}%` }} title={`最大仰角 ${window.maxElevationDeg.toFixed(1)}°`} />;
            })}
          </div>
        </div>
        <div className="timeline-lane">
          <span className="lane-label">成像任务</span>
          <div className="task-strip">
            {tasks.length ? tasks.map((task) => (
              <button key={task.id} className={`task-chip ${task.status}`} onClick={() => useWorkbenchStore.getState().setSelection({ kind: "task", id: task.id })}>
                {task.status === "conflict" ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}{task.name}
              </button>
            )) : <span className="empty-inline">尚未建立任务</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
