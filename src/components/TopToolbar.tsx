import {
  Box,
  FilePlus2,
  FolderOpen,
  MousePointer2,
  Pause,
  PenTool,
  Play,
  Redo2,
  RotateCw,
  Save,
  Scaling,
  Trash2,
  Undo2
} from "lucide-react";
import { useWorkbenchStore } from "../store/workbenchStore";

function IconButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return <button className="icon-button" type="button" {...props} />;
}

export function TopToolbar() {
  const toolMode = useWorkbenchStore((state) => state.toolMode);
  const viewMode = useWorkbenchStore((state) => state.viewMode);
  const isPlaying = useWorkbenchStore((state) => state.isPlaying);
  const dirty = useWorkbenchStore((state) => state.dirty);
  const projectPath = useWorkbenchStore((state) => state.projectPath);
  const store = useWorkbenchStore;

  const save = async (saveAs = false) => {
    const state = store.getState();
    const result = await window.stripeApi.saveProject(state.snapshot(), saveAs ? undefined : state.projectPath);
    if (!result.canceled) state.markSaved(result.filePath);
  };

  const open = async () => {
    if (store.getState().dirty && !window.confirm("当前项目有未保存修改，仍要打开其他项目吗？")) return;
    const result = await window.stripeApi.openProject();
    if (!result.canceled && result.snapshot) store.getState().hydrate(result.snapshot, result.filePath);
  };

  return (
    <header className="top-toolbar">
      <div className="brand-block">
        <strong>Stripe</strong>
        <span>卫星规划工作台 0.3.4</span>
      </div>
      <div className="toolbar-group">
        <IconButton title="新建项目" onClick={() => { if (!store.getState().dirty || window.confirm("当前项目有未保存修改，仍要新建项目吗？")) store.getState().resetProject(); }}><FilePlus2 size={17} /></IconButton>
        <IconButton title="打开项目" onClick={open}><FolderOpen size={17} /></IconButton>
        <IconButton title="保存项目" onClick={() => void save(false)}><Save size={17} /></IconButton>
        <IconButton title="撤销" onClick={() => store.getState().undo()}><Undo2 size={17} /></IconButton>
        <IconButton title="重做" onClick={() => store.getState().redo()}><Redo2 size={17} /></IconButton>
        <IconButton title="删除所选对象" onClick={() => store.getState().deleteSelected()}><Trash2 size={17} /></IconButton>
      </div>
      <div className="toolbar-divider" />
      <div className="toolbar-group segmented-icons" aria-label="条带工具">
        <IconButton className={toolMode === "select" ? "icon-button active" : "icon-button"} title="选择" onClick={() => store.getState().setToolMode("select")}><MousePointer2 size={17} /></IconButton>
        <IconButton className={toolMode === "draw-stripe" ? "icon-button active" : "icon-button"} title="绘制多节点条带（双击或回车完成）" onClick={() => store.getState().setToolMode("draw-stripe")}><PenTool size={17} /></IconButton>
        <IconButton className={toolMode === "rotate" ? "icon-button active" : "icon-button"} title="旋转模式" onClick={() => store.getState().setToolMode("rotate")}><RotateCw size={17} /></IconButton>
        <IconButton className={toolMode === "stretch" ? "icon-button active" : "icon-button"} title="拉伸模式" onClick={() => store.getState().setToolMode("stretch")}><Scaling size={17} /></IconButton>
      </div>
      <div className="toolbar-spacer" />
      <span className="project-indicator" title={projectPath}>{projectPath?.split(/[\\/]/).at(-1) ?? "未命名项目"}{dirty ? " *" : ""}</span>
      <div className="toolbar-group view-switch">
        <button className={viewMode === "2d" ? "active" : ""} onClick={() => store.getState().setViewMode("2d")}>二维</button>
        <button className={viewMode === "3d" ? "active" : ""} onClick={() => store.getState().setViewMode("3d")}><Box size={15} />三维</button>
      </div>
      <button className="play-button" onClick={() => store.getState().setPlaying(!isPlaying)}>
        {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        {isPlaying ? "暂停" : "播放"}
      </button>
    </header>
  );
}
