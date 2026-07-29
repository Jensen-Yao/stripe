# Stripe 卫星条带规划工具

面向 Windows x64 的轻量卫星规划工作台。核心安装包使用 `.NET Framework 4.8 + WebView2`，不捆绑 Electron、浏览器运行时或 Java，因此在保留完整离线矢量地图的同时维持较小体积。

## 主要能力

- 单文件 PMTiles 离线世界地图，含全球海岸、行政区、省州、水系和主要城市；可独立开关彩色地理脉络层、中国标准地图表达参考层，并切换在线 OSM 或高德二维/球面底图。
- 任意多节点条带绘制、参数生成、节点增删、偏移复制、整体移动、WGS84 旋转和主副轴拉伸。
- 数组、CSV、GeoJSON、KML 多条带导入，坐标顺序切换及规范化坐标导出。
- 精确多边形重叠面积、包含关系和双方覆盖率分析。
- H3 0-13 级 GPU 网格显示，大范围超限时明确要求缩小 AOI，不静默降级。
- TLE/SGP4/SDP4、经典六根数和 ECI 状态矢量传播，轨迹、星下点、速度、高度和传感器足迹显示。
- 地面站/带半径目标区域访问窗口、H3 覆盖统计、重访估算和手动成像任务冲突检查。
- 中文原生菜单、加密的 Space-Track 本机凭据和压缩 `.stripeproj` 项目文件。

## 开发与验证

```powershell
npm install
npm run generate:map
npm run dev
npm test
npm run test:e2e
npm run build
```

生成 Windows 安装包：

```powershell
npm run dist:win
```

输出路径为 `release/Stripe-Setup-0.3.7-x64.exe`。系统需具备 Microsoft Edge WebView2 Runtime；当前 Windows 10/11 通常已随 Edge 安装。

高德在线地图为可选底图。二维模式使用高德 Web JS API，三维模式使用高德瓦片的球面检查视图，条带在球面视图中只读。高德二维下，“地理脉络”只在高德内部切换彩色标准地理图与清爽图，不加载或叠加离线世界地图；彩色图包含山地地貌、水系、道路和地名。桌面版首次使用时会尝试从 `D:\Desktop\bot\api\高德地图api\web JS api.txt` 导入 Web JS API Key 与安全密钥，并使用 Windows DPAPI 加密保存在当前用户的本机应用数据目录；也可在“分析 > 图层显示”中手动选择配置文件。密钥不会写入项目文件或 Git 仓库。

中国标准地图表达层用于规划显示，覆盖台湾省、钓鱼岛、南海诸岛及相关边界表达，不参与轨道、坐标和面积计算。离线地理参考来自 Natural Earth，行政区划参考几何来自阿里云 DataV。高德二维底图采用 GCJ-02，显示适配器会同步转换地图中心并补偿 WebGL 与高德的一级缩放差；规划对象和分析结果仍以 WGS84 保存和计算。

`orbit-engine` 保留为可选 Orekit 科学扩展源码，不进入轻量核心安装包。轨道结果用于研究与工程规划，不作为飞控、碰撞预警或任务安全认证结果。
