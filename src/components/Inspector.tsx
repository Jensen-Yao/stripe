import { Fragment, useMemo, useState } from "react";
import { BarChart3, Clipboard, CopyPlus, KeyRound, Orbit, PlayCircle, Plus, RefreshCw, ScanLine, Settings2, Trash2 } from "lucide-react";
import { coordinatesForOutput, normalizePoint, stripeCenter, stripeMetrics, transformStripe, validateStripePolygon } from "../domain/geometry";
import { parseStripeInput } from "../domain/importers";
import { makeId } from "../domain/id";
import { closestOrbitSample, createSensorFootprint, formatSensorFov, orbitHeadingAtIndex } from "../domain/sensorFov";
import type { BaseMapMode, CoordinateOrder, GroundAsset, OrbitSample, OrbitSource, Sensor, Spacecraft, Stripe, TaskPlan, WorkspaceTab } from "../domain/types";
import { analyzeCoverage, analyzeOverlaps } from "../services/analysisClient";
import { computeAccess, propagateOrbit } from "../services/orbitClient";
import { useWorkbenchStore } from "../store/workbenchStore";

const tabs: { id: WorkspaceTab; label: string; icon: React.ReactNode }[] = [
  { id: "properties", label: "属性", icon: <Settings2 size={14} /> },
  { id: "orbit", label: "轨道", icon: <Orbit size={14} /> },
  { id: "analysis", label: "分析", icon: <BarChart3 size={14} /> },
  { id: "tasks", label: "任务", icon: <ScanLine size={14} /> }
];
const EMPTY_ORBIT_SAMPLES: OrbitSample[] = [];

function localDateTimeValue(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function NumberField({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (value: number) => void }) {
  return <label className="field-row"><span>{label}</span><input type="number" step={step} value={Number.isFinite(value) ? value : 0} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function ScenarioProperties() {
  const scenario = useWorkbenchStore((state) => state.scenario);
  const setScenario = useWorkbenchStore((state) => state.setScenario);
  return <div className="inspector-section">
    <h3>场景时间</h3>
    <label className="field-row"><span>名称</span><input value={scenario.name} onChange={(event) => setScenario({ name: event.target.value })} /></label>
    <label className="field-row"><span>开始</span><input type="datetime-local" step="1" value={localDateTimeValue(scenario.startTime)} onChange={(event) => setScenario({ startTime: new Date(event.target.value).toISOString() })} /></label>
    <label className="field-row"><span>结束</span><input type="datetime-local" step="1" value={localDateTimeValue(scenario.endTime)} onChange={(event) => setScenario({ endTime: new Date(event.target.value).toISOString() })} /></label>
    <NumberField label="播放倍率" value={scenario.playbackSpeed} onChange={(playbackSpeed) => setScenario({ playbackSpeed: Math.max(1, playbackSpeed) })} />
    <NumberField label="采样步长 s" value={scenario.sampleStepSeconds} onChange={(sampleStepSeconds) => setScenario({ sampleStepSeconds: Math.max(1, sampleStepSeconds) })} />
  </div>;
}

function StripeProperties({ stripe }: { stripe: Stripe }) {
  const commitStripe = useWorkbenchStore((state) => state.commitStripe);
  const addStripe = useWorkbenchStore((state) => state.addStripe);
  const [order, setOrder] = useState<CoordinateOrder>("lonlat");
  const [offset, setOffset] = useState({ distanceKm: 20, bearingDeg: 90 });
  const metrics = stripeMetrics(stripe.corners);
  const output = JSON.stringify(coordinatesForOutput(stripe.corners, order));
  const commitCorners = (corners: Stripe["corners"], message?: string) => {
    const validation = validateStripePolygon(corners);
    if (!validation.valid) {
      useWorkbenchStore.getState().setStatus(validation.reason ?? "条带边界无效");
      return;
    }
    commitStripe(stripe.id, { ...stripe, corners, updatedAt: new Date().toISOString() });
    if (message) useWorkbenchStore.getState().setStatus(message);
  };
  const duplicateAtOffset = () => {
    const heading = offset.bearingDeg * Math.PI / 180;
    const timestamp = new Date().toISOString();
    const copy: Stripe = {
      ...stripe,
      id: makeId("stripe"),
      name: `${stripe.name} 副本`,
      corners: transformStripe(stripe.corners, { translateEastKm: Math.sin(heading) * offset.distanceKm, translateNorthKm: Math.cos(heading) * offset.distanceKm }),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    addStripe(copy);
    useWorkbenchStore.getState().setStatus(`已按 ${offset.bearingDeg.toFixed(1)}° 偏移 ${offset.distanceKm.toFixed(1)} km 复制条带`);
  };
  const copyGeoJson = () => navigator.clipboard.writeText(JSON.stringify({
    type: "Feature",
    properties: { id: stripe.id, name: stripe.name },
    geometry: { type: "Polygon", coordinates: [[...coordinatesForOutput(stripe.corners, "lonlat"), coordinatesForOutput(stripe.corners, "lonlat")[0]]] }
  }));
  return <div className="inspector-section">
    <h3>条带属性</h3>
    <label className="field-row"><span>名称</span><input value={stripe.name} onChange={(event) => commitStripe(stripe.id, { ...stripe, name: event.target.value, updatedAt: new Date().toISOString() })} /></label>
    <label className="check-field"><input type="checkbox" checked={stripe.visible} onChange={(event) => commitStripe(stripe.id, { ...stripe, visible: event.target.checked, updatedAt: new Date().toISOString() })} />显示条带</label>
    <label className="field-row"><span>颜色</span><input type="color" value={stripe.color} onChange={(event) => commitStripe(stripe.id, { ...stripe, color: event.target.value, updatedAt: new Date().toISOString() })} /></label>
    <div className="metrics-table">
      <span>中心</span><strong>{metrics.center.lat.toFixed(5)}, {metrics.center.lon.toFixed(5)}</strong>
      <span>长 / 宽</span><strong>{metrics.lengthKm.toFixed(2)} / {metrics.widthKm.toFixed(2)} km</strong>
      <span>面积</span><strong>{metrics.areaKm2.toFixed(2)} km²</strong>
      <span>周长 / 节点</span><strong>{metrics.perimeterKm.toFixed(2)} km / {metrics.vertexCount}</strong>
      <span>方位</span><strong>{metrics.headingDeg.toFixed(2)}°</strong>
    </div>
    <label className="field-row"><span>坐标顺序</span><select value={order} onChange={(event) => setOrder(event.target.value as CoordinateOrder)}><option value="lonlat">[经度, 纬度]</option><option value="latlon">[纬度, 经度]</option></select></label>
    <textarea className="coordinate-output" readOnly value={output} />
    <div className="command-grid stripe-command-grid">
      <button className="primary-command" onClick={() => void navigator.clipboard.writeText(output)}><Clipboard size={15} />复制数组</button>
      <button onClick={() => void copyGeoJson()}><Clipboard size={15} />复制 GeoJSON</button>
      <button onClick={() => commitCorners([...stripe.corners].reverse(), "已反转节点顺序")}><RefreshCw size={15} />反转顺序</button>
    </div>
    <h3>偏移复制</h3>
    <div className="compact-grid">
      <label><span>距离 km</span><input type="number" step="0.1" value={offset.distanceKm} onChange={(event) => setOffset((value) => ({ ...value, distanceKm: Number(event.target.value) }))} /></label>
      <label><span>方位角 °</span><input type="number" step="1" value={offset.bearingDeg} onChange={(event) => setOffset((value) => ({ ...value, bearingDeg: Number(event.target.value) }))} /></label>
    </div>
    <button onClick={duplicateAtOffset}><CopyPlus size={15} />生成偏移副本</button>
    <details className="vertex-editor">
      <summary>节点坐标编辑（{stripe.corners.length}）</summary>
      <div className="vertex-list">
        {stripe.corners.map((point, index) => <div className="vertex-row" key={`${stripe.updatedAt}-${index}`}>
          <span>{index + 1}</span>
          <input aria-label={`节点 ${index + 1} 经度`} type="number" step="0.000001" defaultValue={point.lon} onBlur={(event) => {
            const corners = [...stripe.corners];
            corners[index] = normalizePoint({ ...corners[index], lon: Number(event.currentTarget.value) });
            commitCorners(corners);
          }} />
          <input aria-label={`节点 ${index + 1} 纬度`} type="number" step="0.000001" defaultValue={point.lat} onBlur={(event) => {
            const corners = [...stripe.corners];
            corners[index] = normalizePoint({ ...corners[index], lat: Number(event.currentTarget.value) });
            commitCorners(corners);
          }} />
          <button title="删除节点" disabled={stripe.corners.length <= 3} onClick={() => commitCorners(stripe.corners.filter((_value, valueIndex) => valueIndex !== index), `已删除第 ${index + 1} 个节点`)}><Trash2 size={13} /></button>
        </div>)}
      </div>
      <button onClick={() => {
        const last = stripe.corners.at(-1)!;
        const first = stripe.corners[0];
        commitCorners([...stripe.corners, stripeCenter([last, first])], "已在末边插入节点");
      }}><Plus size={14} />在末边插入节点</button>
    </details>
  </div>;
}

function SpacecraftProperties({ spacecraft }: { spacecraft: Spacecraft }) {
  const setSpacecraft = useWorkbenchStore((state) => state.setSpacecraft);
  const sensor = useWorkbenchStore((state) => state.sensors.find((item) => item.spacecraftId === spacecraft.id));
  const setSensor = useWorkbenchStore((state) => state.setSensor);
  const updateOrbit = (patch: Record<string, unknown>) => setSpacecraft(spacecraft.id, { orbit: { ...spacecraft.orbit, ...patch } as Spacecraft["orbit"] });
  const changeOrbitType = (type: OrbitSource["type"]) => {
    const epoch = new Date().toISOString();
    const orbit: OrbitSource = type === "tle" ? {
      type: "tle", name: spacecraft.name, line1: "1 25544U 98067A   26166.47439209  .00016717  00000+0  30136-3 0  9997", line2: "2 25544  51.6313 331.6938 0003417 113.3422 246.7928 15.50065061517066"
    } : type === "keplerian" ? {
      type: "keplerian", epoch, semiMajorAxisKm: 6878.137, eccentricity: 0.001, inclinationDeg: 97.4, raanDeg: 0, argumentOfPerigeeDeg: 0, anomalyDeg: 0, anomalyType: "true", frame: "GCRF"
    } : type === "cartesian" ? {
      type: "cartesian", epoch, frame: "GCRF", positionKm: [6878.137, 0, 0], velocityKmS: [0, 7.612, 0]
    } : { type, fileName: "", localPath: "" };
    setSpacecraft(spacecraft.id, { orbit });
  };
  const chooseFile = async () => {
    if (spacecraft.orbit.type !== "omm" && spacecraft.orbit.type !== "oem" && spacecraft.orbit.type !== "sp3") return;
    const result = await window.stripeApi.chooseOrbitFile(spacecraft.orbit.type);
    if (!result.canceled && result.filePath) updateOrbit({ localPath: result.filePath, fileName: result.filePath.split(/[\\/]/).at(-1) ?? result.filePath });
  };
  const setVectorValue = (field: "positionKm" | "velocityKmS", index: number, value: number) => {
    if (spacecraft.orbit.type !== "cartesian") return;
    const vector = [...spacecraft.orbit[field]] as [number, number, number];
    vector[index] = value;
    updateOrbit({ [field]: vector });
  };
  return <div className="inspector-section">
    <h3>卫星属性</h3>
    <label className="field-row"><span>名称</span><input value={spacecraft.name} onChange={(event) => setSpacecraft(spacecraft.id, { name: event.target.value })} /></label>
    <label className="check-field"><input type="checkbox" checked={spacecraft.visible} onChange={(event) => setSpacecraft(spacecraft.id, { visible: event.target.checked })} />显示卫星</label>
    <label className="field-row"><span>传播配置</span><select value={spacecraft.profile} onChange={(event) => setSpacecraft(spacecraft.id, { profile: event.target.value as Spacecraft["profile"] })}><option value="fast">快速</option><option value="planning">规划</option><option value="research">研究（需科学扩展）</option></select></label>
    <label className="field-row"><span>轨道来源</span><select value={spacecraft.orbit.type} onChange={(event) => changeOrbitType(event.target.value as OrbitSource["type"])}><option value="tle">TLE / SGP4</option><option value="keplerian">经典六根数</option><option value="cartesian">ECI 状态矢量</option><option value="omm">CCSDS OMM</option><option value="oem">CCSDS OEM</option><option value="sp3">SP3 精密星历</option></select></label>
    {spacecraft.orbit.type === "tle" && <>
      <label className="stacked-field"><span>TLE 第一行</span><textarea value={spacecraft.orbit.line1} onChange={(event) => updateOrbit({ line1: event.target.value })} /></label>
      <label className="stacked-field"><span>TLE 第二行</span><textarea value={spacecraft.orbit.line2} onChange={(event) => updateOrbit({ line2: event.target.value })} /></label>
    </>}
    {spacecraft.orbit.type === "keplerian" && <>
      <label className="field-row"><span>历元</span><input type="datetime-local" step="1" value={localDateTimeValue(spacecraft.orbit.epoch)} onChange={(event) => updateOrbit({ epoch: new Date(event.target.value).toISOString() })} /></label>
      <NumberField label="半长轴 km" value={spacecraft.orbit.semiMajorAxisKm} step={0.001} onChange={(semiMajorAxisKm) => updateOrbit({ semiMajorAxisKm })} />
      <NumberField label="偏心率" value={spacecraft.orbit.eccentricity} step={0.000001} onChange={(eccentricity) => updateOrbit({ eccentricity })} />
      <NumberField label="倾角 °" value={spacecraft.orbit.inclinationDeg} step={0.001} onChange={(inclinationDeg) => updateOrbit({ inclinationDeg })} />
      <NumberField label="升交点赤经 °" value={spacecraft.orbit.raanDeg} step={0.001} onChange={(raanDeg) => updateOrbit({ raanDeg })} />
      <NumberField label="近地点幅角 °" value={spacecraft.orbit.argumentOfPerigeeDeg} step={0.001} onChange={(argumentOfPerigeeDeg) => updateOrbit({ argumentOfPerigeeDeg })} />
      <NumberField label="近点角 °" value={spacecraft.orbit.anomalyDeg} step={0.001} onChange={(anomalyDeg) => updateOrbit({ anomalyDeg })} />
    </>}
    {spacecraft.orbit.type === "cartesian" && <>
      <label className="field-row"><span>历元</span><input type="datetime-local" step="1" value={localDateTimeValue(spacecraft.orbit.epoch)} onChange={(event) => updateOrbit({ epoch: new Date(event.target.value).toISOString() })} /></label>
      {[0,1,2].map((index) => <NumberField key={`p-${index}`} label={`位置 ${"XYZ"[index]} km`} value={spacecraft.orbit.type === "cartesian" ? spacecraft.orbit.positionKm[index] : 0} step={0.001} onChange={(value) => setVectorValue("positionKm", index, value)} />)}
      {[0,1,2].map((index) => <NumberField key={`v-${index}`} label={`速度 ${"XYZ"[index]} km/s`} value={spacecraft.orbit.type === "cartesian" ? spacecraft.orbit.velocityKmS[index] : 0} step={0.000001} onChange={(value) => setVectorValue("velocityKmS", index, value)} />)}
    </>}
    {(spacecraft.orbit.type === "omm" || spacecraft.orbit.type === "oem" || spacecraft.orbit.type === "sp3") && <>
      <label className="stacked-field"><span>轨道文件</span><input readOnly value={spacecraft.orbit.localPath} placeholder="尚未选择文件" /></label>
      <button onClick={() => void chooseFile()}>选择 {spacecraft.orbit.type.toUpperCase()} 文件</button>
    </>}
    <h3>物理参数</h3>
    <NumberField label="质量 kg" value={spacecraft.physical.massKg} onChange={(massKg) => setSpacecraft(spacecraft.id, { physical: { ...spacecraft.physical, massKg } })} />
    <NumberField label="阻力面积 m²" value={spacecraft.physical.dragAreaM2} onChange={(dragAreaM2) => setSpacecraft(spacecraft.id, { physical: { ...spacecraft.physical, dragAreaM2 } })} />
    <NumberField label="Cd" value={spacecraft.physical.dragCoefficient} step={0.01} onChange={(dragCoefficient) => setSpacecraft(spacecraft.id, { physical: { ...spacecraft.physical, dragCoefficient } })} />
    <NumberField label="Cr" value={spacecraft.physical.reflectivityCoefficient} step={0.01} onChange={(reflectivityCoefficient) => setSpacecraft(spacecraft.id, { physical: { ...spacecraft.physical, reflectivityCoefficient } })} />
    {sensor && <>
      <h3>传感器与机动约束</h3>
      <label className="field-row"><span>视场形状</span><select value={sensor.shape} onChange={(event) => setSensor(sensor.id, { shape: event.target.value as "conical" | "rectangular" })}><option value="conical">圆锥</option><option value="rectangular">矩形</option></select></label>
      {sensor.shape === "conical" ? <NumberField label="半锥角 °" value={sensor.halfConeDeg} step={0.1} onChange={(halfConeDeg) => setSensor(sensor.id, { halfConeDeg })} /> : <>
        <NumberField label="横向视场 °" value={sensor.crossTrackFovDeg} step={0.1} onChange={(crossTrackFovDeg) => setSensor(sensor.id, { crossTrackFovDeg })} />
        <NumberField label="沿轨视场 °" value={sensor.alongTrackFovDeg} step={0.1} onChange={(alongTrackFovDeg) => setSensor(sensor.id, { alongTrackFovDeg })} />
      </>}
      <NumberField label="最大侧摆 °" value={sensor.maxOffNadirDeg} step={0.1} onChange={(maxOffNadirDeg) => setSensor(sensor.id, { maxOffNadirDeg })} />
      <NumberField label="角速度 °/s" value={sensor.maxSlewRateDegS} step={0.1} onChange={(maxSlewRateDegS) => setSensor(sensor.id, { maxSlewRateDegS })} />
      <NumberField label="稳定时间 s" value={sensor.settleTimeSeconds} step={1} onChange={(settleTimeSeconds) => setSensor(sensor.id, { settleTimeSeconds })} />
    </>}
  </div>;
}

function GroundProperties({ asset }: { asset: GroundAsset }) {
  const setGroundAsset = useWorkbenchStore((state) => state.setGroundAsset);
  return <div className="inspector-section">
    <h3>{asset.kind === "station" ? "地面站" : "目标区域"}</h3>
    <label className="field-row"><span>名称</span><input value={asset.name} onChange={(event) => setGroundAsset(asset.id, { name: event.target.value })} /></label>
    <label className="check-field"><input type="checkbox" checked={asset.visible} onChange={(event) => setGroundAsset(asset.id, { visible: event.target.checked })} />显示对象</label>
    <label className="field-row"><span>对象类型</span><select value={asset.kind} onChange={(event) => setGroundAsset(asset.id, { kind: event.target.value as GroundAsset["kind"], radiusKm: event.target.value === "station" ? 0 : asset.radiusKm })}><option value="target">目标区域</option><option value="station">地面站</option></select></label>
    <NumberField label="经度" value={asset.location.lon} step={0.000001} onChange={(lon) => setGroundAsset(asset.id, { location: { ...asset.location, lon } })} />
    <NumberField label="纬度" value={asset.location.lat} step={0.000001} onChange={(lat) => setGroundAsset(asset.id, { location: { ...asset.location, lat } })} />
    <NumberField label="高度 km" value={asset.location.heightKm ?? 0} step={0.001} onChange={(heightKm) => setGroundAsset(asset.id, { location: { ...asset.location, heightKm } })} />
    <NumberField label="最小仰角" value={asset.minElevationDeg} step={0.5} onChange={(minElevationDeg) => setGroundAsset(asset.id, { minElevationDeg })} />
    {asset.kind === "target" && <NumberField label="目标半径 km" value={asset.radiusKm} step={0.1} onChange={(radiusKm) => setGroundAsset(asset.id, { radiusKm: Math.max(0, radiusKm) })} />}
    {asset.kind === "target" && <p className="section-note">访问窗口按目标圆域内任一点满足仰角和传感器约束判定。</p>}
  </div>;
}

function validateTaskPlans(tasks: TaskPlan[], sensors: Sensor[]) {
  return tasks.map((task) => {
    const conflicts: string[] = [];
    const sensor = sensors.find((item) => item.id === task.sensorId);
    const offNadir = Math.hypot(task.attitude.rollDeg, task.attitude.pitchDeg);
    if (sensor && offNadir > sensor.maxOffNadirDeg) conflicts.push(`侧摆 ${offNadir.toFixed(1)}° 超过 ${sensor.maxOffNadirDeg.toFixed(1)}°`);
    const peers = tasks.filter((item) => item.id !== task.id && item.spacecraftId === task.spacecraftId);
    peers.forEach((peer) => {
      const overlaps = new Date(peer.startTime).getTime() < new Date(task.endTime).getTime() && new Date(peer.endTime).getTime() > new Date(task.startTime).getTime();
      if (overlaps) conflicts.push(`与 ${peer.name} 时间重叠`);
    });
    const previous = peers
      .filter((peer) => new Date(peer.endTime).getTime() <= new Date(task.startTime).getTime())
      .sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())[0];
    if (sensor && previous) {
      const angle = Math.hypot(task.attitude.rollDeg - previous.attitude.rollDeg, task.attitude.pitchDeg - previous.attitude.pitchDeg, task.attitude.yawDeg - previous.attitude.yawDeg);
      const required = angle / Math.max(0.001, sensor.maxSlewRateDegS) + sensor.settleTimeSeconds;
      const available = (new Date(task.startTime).getTime() - new Date(previous.endTime).getTime()) / 1000;
      if (available < required) conflicts.push(`与 ${previous.name} 之间缺少 ${(required - available).toFixed(1)} s 机动时间`);
    }
    return { ...task, conflicts, status: conflicts.length ? "conflict" as const : "valid" as const };
  });
}

function TaskProperties({ task }: { task: TaskPlan }) {
  const tasks = useWorkbenchStore((state) => state.tasks);
  const sensors = useWorkbenchStore((state) => state.sensors);
  const update = (patch: Partial<TaskPlan>) => {
    const next = tasks.map((item) => item.id === task.id ? { ...item, ...patch } : item);
    useWorkbenchStore.getState().setTasks(validateTaskPlans(next, sensors));
  };
  const attitude = (patch: Partial<TaskPlan["attitude"]>) => update({ attitude: { ...task.attitude, ...patch } });
  return <div className="inspector-section"><h3>成像任务</h3>
    <label className="field-row"><span>名称</span><input value={task.name} onChange={(event) => update({ name: event.target.value })} /></label>
    <label className="field-row"><span>开始</span><input type="datetime-local" step="1" value={task.startTime.slice(0,19)} onChange={(event) => update({ startTime: new Date(event.target.value).toISOString() })} /></label>
    <label className="field-row"><span>结束</span><input type="datetime-local" step="1" value={task.endTime.slice(0,19)} onChange={(event) => update({ endTime: new Date(event.target.value).toISOString() })} /></label>
    <NumberField label="滚转角 °" value={task.attitude.rollDeg} step={0.1} onChange={(rollDeg) => attitude({ rollDeg })} />
    <NumberField label="俯仰角 °" value={task.attitude.pitchDeg} step={0.1} onChange={(pitchDeg) => attitude({ pitchDeg })} />
    <NumberField label="偏航角 °" value={task.attitude.yawDeg} step={0.1} onChange={(yawDeg) => attitude({ yawDeg })} />
    <div className="metrics-table"><span>状态</span><strong>{task.status === "conflict" ? "存在冲突" : "可执行"}</strong>{task.conflicts.map((conflict) => <Fragment key={conflict}><span>约束</span><strong>{conflict}</strong></Fragment>)}</div>
  </div>;
}

function PropertiesTab() {
  const selection = useWorkbenchStore((state) => state.selection);
  const scenario = useWorkbenchStore((state) => state.scenario);
  const stripes = useWorkbenchStore((state) => state.stripes);
  const spacecraft = useWorkbenchStore((state) => state.spacecraft);
  const groundAssets = useWorkbenchStore((state) => state.groundAssets);
  const sensors = useWorkbenchStore((state) => state.sensors);
  const tasks = useWorkbenchStore((state) => state.tasks);
  if (!selection || selection.kind === "scenario") return <ScenarioProperties />;
  if (selection.kind === "stripe") {
    const stripe = stripes.find((item) => item.id === selection.id);
    return stripe ? <StripeProperties stripe={stripe} /> : <ScenarioProperties />;
  }
  if (selection.kind === "spacecraft") {
    const item = spacecraft.find((value) => value.id === selection.id);
    return item ? <SpacecraftProperties spacecraft={item} /> : <ScenarioProperties />;
  }
  if (selection.kind === "groundAsset") {
    const item = groundAssets.find((value) => value.id === selection.id);
    return item ? <GroundProperties asset={item} /> : <ScenarioProperties />;
  }
  if (selection.kind === "task") {
    const item = tasks.find((value) => value.id === selection.id);
    return item ? <TaskProperties task={item} /> : <ScenarioProperties />;
  }
  return <ScenarioProperties />;
}

function OrbitTab() {
  const scenario = useWorkbenchStore((state) => state.scenario);
  const spacecraft = useWorkbenchStore((state) => state.spacecraft);
  const groundAssets = useWorkbenchStore((state) => state.groundAssets);
  const sensors = useWorkbenchStore((state) => state.sensors);
  const selection = useWorkbenchStore((state) => state.selection);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("ISS");
  const [group, setGroup] = useState("stations");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const active = spacecraft.find((item) => selection?.kind === "spacecraft" && item.id === selection.id) ?? spacecraft[0];
  const samples = useWorkbenchStore((state) => active ? state.orbitSamples[active.id] ?? EMPTY_ORBIT_SAMPLES : EMPTY_ORBIT_SAMPLES);
  const currentSample = closestOrbitSample(samples, scenario.currentTime)?.sample;
  const runPropagation = async () => {
    if (!active) return;
    setBusy(true);
    useWorkbenchStore.getState().setStatus("正在后台传播轨道...");
    try {
      const result = await propagateOrbit(active, scenario);
      useWorkbenchStore.getState().setOrbitSamples(active.id, result.samples);
      useWorkbenchStore.getState().setStatus(`轨道传播完成：${result.samples.length} 个样本，内核 ${result.engine}`);
    } catch (error) {
      useWorkbenchStore.getState().setStatus(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  const runAccess = async () => {
    if (!active) return;
    setBusy(true);
    useWorkbenchStore.getState().setStatus("正在计算访问窗口...");
    try {
      const windows = await computeAccess(active, scenario, groundAssets, sensors.find((sensor) => sensor.spacecraftId === active.id));
      useWorkbenchStore.getState().setAccessWindows(windows);
      useWorkbenchStore.getState().setStatus(`访问分析完成：${windows.length} 个窗口`);
    } catch (error) {
      useWorkbenchStore.getState().setStatus(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  const applyFetchedTle = (records: unknown[]) => {
    const record = records[0] as { name?: string; noradId?: string; line1?: string; line2?: string } | undefined;
    if (!active || !record?.line1 || !record.line2) {
      useWorkbenchStore.getState().setStatus("没有返回可用的 TLE");
      return;
    }
    useWorkbenchStore.getState().setSpacecraft(active.id, {
      name: record.name ?? active.name,
      orbit: { type: "tle", name: record.name, noradId: record.noradId, line1: record.line1, line2: record.line2 }
    });
    useWorkbenchStore.getState().setStatus(`已载入 ${record.name ?? record.noradId ?? "TLE"}`);
  };
  const fetchPublicTle = async () => {
    setBusy(true);
    try { applyFetchedTle(await window.stripeApi.fetchCelesTrak({ group, search })); }
    catch (error) { useWorkbenchStore.getState().setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const saveCredentials = async () => {
    if (!username || !password) return;
    await window.stripeApi.saveSpaceTrackCredentials({ username, password });
    setPassword("");
    useWorkbenchStore.getState().setStatus("Space-Track 账号已加密保存到本机");
  };
  const fetchPrivateTle = async () => {
    setBusy(true);
    try { applyFetchedTle(await window.stripeApi.fetchSpaceTrack({ search })); }
    catch (error) { useWorkbenchStore.getState().setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="inspector-section">
    <h3>轨道传播</h3>
    <p className="section-note">轻量核心：TLE 使用 SGP4/SDP4，六根数和 ECI 状态矢量使用 WGS84 二体传播；高阶摄动由可选科学扩展提供。</p>
    <button data-testid="propagate-orbit" className="primary-command" disabled={!active || busy} onClick={() => void runPropagation()}><PlayCircle size={15} />{busy ? "计算中" : "传播场景轨道"}</button>
    <button onClick={() => void runAccess()} disabled={!active || busy}>计算地面访问窗口</button>
    <div className="metrics-table"><span>轨道样本</span><strong>{samples.length}</strong><span>访问对象</span><strong>{groundAssets.length}</strong><span>传播配置</span><strong>{active?.profile ?? "--"}</strong></div>
    {currentSample && <>
      <h3>当前状态</h3>
      <div className="metrics-table">
        <span>经度 / 纬度</span><strong>{currentSample.lon.toFixed(5)}° / {currentSample.lat.toFixed(5)}°</strong>
        <span>高度</span><strong>{currentSample.heightKm.toFixed(3)} km</strong>
        <span>速度</span><strong>{currentSample.speedKmS.toFixed(6)} km/s</strong>
        <span>TEME 位置</span><strong>{currentSample.positionKm?.map((value) => value.toFixed(2)).join(", ") ?? "--"} km</strong>
        <span>TEME 速度</span><strong>{currentSample.velocityKmS?.map((value) => value.toFixed(5)).join(", ") ?? "--"} km/s</strong>
      </div>
    </>}
    <h3>TLE 数据源</h3>
    <label className="field-row"><span>卫星检索</span><input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <label className="field-row"><span>CelesTrak 分组</span><input value={group} onChange={(event) => setGroup(event.target.value)} /></label>
    <button onClick={() => void fetchPublicTle()} disabled={busy}>从 CelesTrak 获取</button>
    <label className="field-row"><span>Space-Track 用户</span><input value={username} onChange={(event) => setUsername(event.target.value)} /></label>
    <label className="field-row"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <div className="command-grid"><button onClick={() => void saveCredentials()}>保存账号</button><button onClick={() => void fetchPrivateTle()} disabled={busy}>获取 Space-Track</button><button onClick={() => void window.stripeApi.clearSpaceTrackCredentials().then(() => useWorkbenchStore.getState().setStatus("Space-Track 账号已清除"))}>清除账号</button></div>
  </div>;
}

function AnalysisTab() {
  const stripeCount = useWorkbenchStore((state) => state.stripes.length);
  const stripes = useWorkbenchStore((state) => state.stripes);
  const overlaps = useWorkbenchStore((state) => state.overlaps);
  const activeOverlapId = useWorkbenchStore((state) => state.activeOverlapId);
  const layers = useWorkbenchStore((state) => state.layerVisibility);
  const h3 = useWorkbenchStore((state) => state.h3);
  const baseMapMode = useWorkbenchStore((state) => state.baseMapMode);
  const coverageResults = useWorkbenchStore((state) => state.coverageResults);
  const selection = useWorkbenchStore((state) => state.selection);
  const spacecraft = useWorkbenchStore((state) => state.spacecraft);
  const sensors = useWorkbenchStore((state) => state.sensors);
  const orbitSamples = useWorkbenchStore((state) => state.orbitSamples);
  const currentTime = useWorkbenchStore((state) => state.scenario.currentTime);
  const [importText, setImportText] = useState("[[116,40],[117,40],[117,39.5],[116,39.5]]");
  const [order, setOrder] = useState<CoordinateOrder>("lonlat");
  const [parameters, setParameters] = useState({ centerLon: 116, centerLat: 40, lengthKm: 500, widthKm: 50, headingDeg: 0 });
  const stripesById = useMemo(() => new Map(stripes.map((stripe) => [stripe.id, stripe])), [stripes]);
  const coverageSatellite = spacecraft.find((item) => selection?.kind === "spacecraft" && item.id === selection.id) ?? spacecraft[0];
  const coverageSensor = sensors.find((item) => item.spacecraftId === coverageSatellite?.id);
  const coverageSamples = coverageSatellite ? orbitSamples[coverageSatellite.id] ?? [] : [];
  const coverageClosest = closestOrbitSample(coverageSamples, currentTime);
  const coverageHeading = useMemo(
    () => coverageClosest ? orbitHeadingAtIndex(coverageSamples, coverageClosest.index) : 0,
    [coverageClosest?.index, coverageSamples]
  );
  const currentFootprint = useMemo(
    () => coverageClosest && coverageSensor
      ? createSensorFootprint(coverageClosest.sample, coverageSensor, coverageHeading)
      : undefined,
    [coverageClosest?.sample, coverageHeading, coverageSensor]
  );
  const importStripes = async () => {
    try {
      const imported = parseStripeInput(importText, order);
      if (!imported.length) throw new Error("未找到有效条带，请检查坐标顺序、节点数量、范围和边界是否自相交");
      const stripes = useWorkbenchStore.getState().stripes;
      const nextStripes = [...stripes, ...imported];
      useWorkbenchStore.getState().addStripes(imported);
      if (nextStripes.length > 1) {
        useWorkbenchStore.getState().setStatus(`已导入 ${imported.length} 条条带，正在分析覆盖关系...`);
        const result = await analyzeOverlaps(nextStripes);
        useWorkbenchStore.getState().setOverlaps(result);
        useWorkbenchStore.getState().setStatus(`已导入 ${imported.length} 条条带，发现 ${result.length} 组覆盖关系`);
      } else {
        useWorkbenchStore.getState().setStatus(`已导入 ${imported.length} 条条带`);
      }
    } catch (error) {
      useWorkbenchStore.getState().setStatus(error instanceof Error ? error.message : "条带导入失败");
    }
  };
  const runOverlap = async () => {
    useWorkbenchStore.getState().setStatus("正在后台分析条带覆盖关系...");
    try {
      const result = await analyzeOverlaps(useWorkbenchStore.getState().stripes);
      useWorkbenchStore.getState().setOverlaps(result);
      useWorkbenchStore.getState().setStatus(`覆盖关系分析完成：${result.length} 组重叠`);
    } catch (error) { useWorkbenchStore.getState().setStatus(error instanceof Error ? error.message : String(error)); }
  };
  const runCoverage = async () => {
    const stripes = useWorkbenchStore.getState().stripes;
    const stripe = stripes.find((item) => selection?.kind === "stripe" && item.id === selection.id) ?? stripes[0];
    if (!stripe || !coverageSatellite || !coverageSensor || !coverageSamples.length) {
      useWorkbenchStore.getState().setStatus("覆盖分析需要条带、卫星传感器和已传播的轨道样本");
      return;
    }
    useWorkbenchStore.getState().setLayerVisibility({ coverage: true });
    useWorkbenchStore.getState().setStatus("正在后台计算 H3 覆盖统计...");
    try {
      const value = await analyzeCoverage(stripe, coverageSamples, coverageSensor, h3.resolution, h3.maxCells);
      useWorkbenchStore.getState().setCoverageResult(value.result, value.coveredCells);
      useWorkbenchStore.getState().setStatus(`覆盖分析完成：${value.result.coveragePercent.toFixed(1)}%${value.horizonClipped ? "；视场已裁剪至可见地平线" : ""}`);
    } catch (error) { useWorkbenchStore.getState().setStatus(error instanceof Error ? error.message : String(error)); }
  };
  const selectBaseMap = (mode: BaseMapMode) => {
    useWorkbenchStore.getState().setBaseMapMode(mode);
    useWorkbenchStore.getState().setStatus(mode === "amap"
      ? useWorkbenchStore.getState().viewMode === "3d" ? "正在加载高德球面地图..." : "正在连接高德在线地图..."
      : mode === "osm" ? "已切换到 OSM 在线地图" : "已切换到离线矢量地图");
  };
  const configureAmap = async () => {
    try {
      const result = await window.stripeApi.chooseAmapConfig();
      if (result.canceled) return;
      useWorkbenchStore.getState().setStatus(result.configured ? "高德地图 API 配置已加密保存" : "高德地图 API 配置未保存");
    } catch (error) {
      useWorkbenchStore.getState().setStatus(error instanceof Error ? error.message : "高德地图 API 配置失败");
    }
  };
  return <div className="inspector-section">
    <h3>图层显示</h3>
    <div className="basemap-field">
      <span>底图</span>
      <div className="basemap-switch" role="group" aria-label="底图">
        {([['offline', '离线'], ['osm', 'OSM'], ['amap', '高德地图']] as const).map(([mode, label]) => <button
          type="button"
          key={mode}
          data-testid={`basemap-${mode}`}
          className={baseMapMode === mode ? "active" : ""}
          aria-pressed={baseMapMode === mode}
          onClick={() => selectBaseMap(mode)}
        >{label}</button>)}
      </div>
    </div>
    <button className="amap-config-command" type="button" onClick={() => void configureAmap()} title="选择并加密保存高德地图 Web JS API 配置"><KeyRound size={14} />配置高德地图 API</button>
    <div className="toggle-grid">
      <label title={baseMapMode === "amap" && useWorkbenchStore.getState().viewMode === "2d" ? "二维高德与本地地理脉络互斥：开启时显示本地 WGS84 地理底图，关闭时显示高德 GCJ-02 底图" : "显示国家、行政区、湖泊、河流和通用地名的彩色地理参考层"}><input type="checkbox" checked={layers.geographicContext} onChange={(event) => useWorkbenchStore.getState().setLayerVisibility({ geographicContext: event.target.checked })} />地理脉络</label>
      <label title={baseMapMode === "amap" ? "高德底图已包含中国地图表达" : undefined}><input type="checkbox" checked={layers.chinaStandardMap} disabled={baseMapMode === "amap"} onChange={(event) => useWorkbenchStore.getState().setLayerVisibility({ chinaStandardMap: event.target.checked })} />{baseMapMode === "amap" ? "中国表达（高德内置）" : "中国标准表达"}</label>
      {([['stripes','条带'],['satellites','卫星'],['groundTracks','轨迹'],['coverage','覆盖 / 视场'],['groundAssets','地面对象']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={layers[key]} onChange={(event) => useWorkbenchStore.getState().setLayerVisibility({ [key]: event.target.checked })} />{label}</label>)}
    </div>
    <p className="section-note">{baseMapMode === "amap" ? "二维模式下，高德底图与地理脉络互斥：开启地理脉络时使用本地 WGS84 地理底图，不叠加高德；关闭后显示高德 GCJ-02 底图。三维按钮切换高德球面地图。规划坐标与计算结果保持 WGS84。" : "中国标准表达层用于规划显示，覆盖台湾省、钓鱼岛、南海诸岛及相关边界；地理脉络层用于通用国家、水系和行政参考，两者都不参与坐标和面积计算。"}</p>
    <h3>H3 网格</h3>
    <label className="check-field"><input type="checkbox" checked={h3.visible} onChange={(event) => useWorkbenchStore.getState().setH3({ visible: event.target.checked })} />显示网格</label>
    <NumberField label="层级 0-13" value={h3.resolution} onChange={(resolution) => useWorkbenchStore.getState().setH3({ resolution: Math.min(13, Math.max(0, Math.round(resolution))) })} />
    <label className="field-row"><span>显示上限</span><select value={h3.displayMaxCells} onChange={(event) => useWorkbenchStore.getState().setH3({ displayMaxCells: Number(event.target.value) })}><option value={200000}>20 万（流畅）</option><option value={500000}>50 万（推荐）</option><option value={1000000}>100 万（高负载）</option></select></label>
    <p className="section-note">保持真实层级，不会自动降级。高层级自动进入可辨识比例尺；超限时渐进显示视野中心区域。</p>
    <h3>参数生成条带</h3>
    <div className="compact-grid">
      {Object.entries(parameters).map(([key, value]) => <label key={key}><span>{{centerLon:'中心经度',centerLat:'中心纬度',lengthKm:'长度 km',widthKm:'宽度 km',headingDeg:'方位角'}[key as keyof typeof parameters]}</span><input type="number" value={value} onChange={(event) => setParameters((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>)}
    </div>
    <button className="primary-command" onClick={() => useWorkbenchStore.getState().addGeneratedStripe(parameters)}><Plus size={15} />生成条带</button>
    <h3>批量导入</h3>
    <label className="field-row"><span>坐标顺序</span><select value={order} onChange={(event) => setOrder(event.target.value as CoordinateOrder)}><option value="lonlat">经度, 纬度</option><option value="latlon">纬度, 经度</option></select></label>
    <textarea className="import-area" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="支持数组、CSV、GeoJSON、KML" />
    <button onClick={() => void importStripes()}>导入条带并分析</button>
    <h3>覆盖关系</h3>
    <button className="primary-command" disabled={stripeCount < 2} onClick={() => void runOverlap()}><BarChart3 size={15} />运行精确重叠分析</button>
    <div className="analysis-results">{overlaps.length ? overlaps.slice(0, 30).map((item) => {
      const stripeA = stripesById.get(item.stripeAId);
      const stripeB = stripesById.get(item.stripeBId);
      const selectComparison = () => {
        useWorkbenchStore.getState().setActiveOverlap(item.id);
        useWorkbenchStore.getState().setStatus(`正在比较 A：${stripeA?.name ?? item.stripeAId}；B：${stripeB?.name ?? item.stripeBId}`);
      };
      return <button
        className={activeOverlapId === item.id ? "active" : ""}
        data-testid="overlap-result"
        aria-pressed={activeOverlapId === item.id}
        key={item.id}
        onClick={selectComparison}
      >
        <span className="overlap-heading"><strong>{{ overlap: "部分重叠", a_contains_b: "A 包含 B", b_contains_a: "B 包含 A", same: "完全重合" }[item.relation]}</strong><em>{item.overlapAreaKm2.toFixed(2)} km²</em></span>
        <span className="overlap-entity" title={stripeA?.name ?? item.stripeAId}><b className="overlap-role role-a">A</b><i style={{ backgroundColor: stripeA?.color ?? "#2583c4" }} /><span>{stripeA?.name ?? item.stripeAId}</span><em>{item.overlapPercentOfA.toFixed(1)}% 被覆盖</em></span>
        <span className="overlap-entity" title={stripeB?.name ?? item.stripeBId}><b className="overlap-role role-b">B</b><i style={{ backgroundColor: stripeB?.color ?? "#e4772e" }} /><span>{stripeB?.name ?? item.stripeBId}</span><em>{item.overlapPercentOfB.toFixed(1)}% 被覆盖</em></span>
      </button>;
    }) : <p className="empty-state">尚无覆盖分析结果</p>}</div>
    <h3>轨道覆盖统计</h3>
    {coverageSensor && <div className="fov-summary" data-testid="coverage-fov-summary">
      <div className="fov-summary-title"><ScanLine size={15} /><span>传感器视场</span><strong>{coverageSensor.shape === "conical" ? "圆锥" : "矩形"} {formatSensorFov(coverageSensor)}</strong></div>
      <div className="metrics-table">
        <span>当前地面足迹</span><strong>{currentFootprint ? `${(currentFootprint.crossTrackRadiusKm * 2).toFixed(1)} × ${(currentFootprint.alongTrackRadiusKm * 2).toFixed(1)} km` : "等待轨道样本"}</strong>
        <span>轨道航向</span><strong>{coverageClosest ? `${coverageHeading.toFixed(1)}°` : "--"}</strong>
        <span>地平线裁切</span><strong>{currentFootprint?.horizonClipped ? "已裁切" : "未触发"}</strong>
      </div>
    </div>}
    <button onClick={() => void runCoverage()}>计算所选条带覆盖</button>
    {coverageResults[0] && <div className="metrics-table"><span>覆盖率</span><strong>{coverageResults[0].coveragePercent.toFixed(2)}%</strong><span>网格</span><strong>{coverageResults[0].coveredCellCount} / {coverageResults[0].totalCellCount}</strong><span>重访</span><strong>{coverageResults[0].revisitMinutes ? `${coverageResults[0].revisitMinutes.toFixed(1)} 分钟` : "--"}</strong></div>}
  </div>;
}

function TasksTab() {
  const windows = useWorkbenchStore((state) => state.accessWindows);
  const sensors = useWorkbenchStore((state) => state.sensors);
  const tasks = useWorkbenchStore((state) => state.tasks);
  const groundAssets = useWorkbenchStore((state) => state.groundAssets);
  const addFromWindow = (windowId: string) => {
    const window = windows.find((item) => item.id === windowId);
    const sensor = sensors.find((item) => item.spacecraftId === window?.spacecraftId);
    if (!window || !sensor) return;
    const conflicts = tasks.filter((task) => task.spacecraftId === window.spacecraftId && new Date(task.startTime).getTime() < new Date(window.endTime).getTime() && new Date(task.endTime).getTime() > new Date(window.startTime).getTime());
    const task: TaskPlan = {
      id: makeId("task"), name: `成像任务 ${tasks.length + 1}`, spacecraftId: window.spacecraftId, sensorId: sensor.id, targetId: window.targetId,
      startTime: window.startTime, endTime: window.endTime, attitude: { mode: "task-pointing", rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
      status: conflicts.length ? "conflict" : "valid", conflicts: conflicts.map((item) => `与 ${item.name} 时间重叠`)
    };
    useWorkbenchStore.getState().setTasks(validateTaskPlans([...tasks, task], sensors));
  };
  return <div className="inspector-section"><h3>手动任务计划</h3><p className="section-note">从访问窗口建立任务，并检查卫星、传感器和时间重叠约束。</p><div className="window-list">{windows.length ? windows.map((window) => <button key={window.id} onClick={() => addFromWindow(window.id)}><strong>{groundAssets.find((item) => item.id === window.targetId)?.name ?? window.targetId}</strong><span>{new Date(window.startTime).toLocaleTimeString("zh-CN")} - {new Date(window.endTime).toLocaleTimeString("zh-CN")}</span><small>最大仰角 {window.maxElevationDeg.toFixed(1)}°</small></button>) : <p className="empty-state">先在“轨道”页计算访问窗口</p>}</div></div>;
}

export function Inspector() {
  const activeTab = useWorkbenchStore((state) => state.activeTab);
  return <aside className="inspector-panel"><nav className="inspector-tabs">{tabs.map((tab) => <button data-testid={`tab-${tab.id}`} key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => useWorkbenchStore.getState().setActiveTab(tab.id)}>{tab.icon}{tab.label}</button>)}</nav><div className="inspector-scroll">{activeTab === "properties" ? <PropertiesTab /> : activeTab === "orbit" ? <OrbitTab /> : activeTab === "analysis" ? <AnalysisTab /> : <TasksTab />}</div></aside>;
}
