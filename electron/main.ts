import { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

type TleRecord = {
  name: string;
  noradId?: string;
  line1: string;
  line2: string;
  source: "manual" | "celestrak" | "spacetrack";
  fetchedAt: string;
};

type SpaceTrackCredentials = {
  username: string;
  password: string;
};

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

function installChineseMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" }
      ]
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "close", label: "关闭" }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于",
          click: async () => {
            await dialog.showMessageBox({
              type: "info",
              title: "关于",
              message: "卫星条带规划工具",
              detail: "轻量 STK 风格条带规划、TLE 轨道与访问覆盖基础仿真工具。"
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function credentialsPath() {
  return path.join(app.getPath("userData"), "spacetrack.credentials");
}

async function readCredentials(): Promise<SpaceTrackCredentials | null> {
  try {
    const encrypted = await fs.readFile(credentialsPath());
    const plain = safeStorage.decryptString(encrypted);
    return JSON.parse(plain) as SpaceTrackCredentials;
  } catch {
    return null;
  }
}

async function writeCredentials(credentials: SpaceTrackCredentials) {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
  await fs.writeFile(credentialsPath(), encrypted);
}

function parseTleText(text: string, source: TleRecord["source"]): TleRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const records: TleRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const maybeName = lines[index];
    const line1 = maybeName.startsWith("1 ") ? maybeName : lines[index + 1];
    const line2 = maybeName.startsWith("1 ") ? lines[index + 1] : lines[index + 2];
    if (line1?.startsWith("1 ") && line2?.startsWith("2 ")) {
      const satNumber = line1.slice(2, 7).trim();
      records.push({
        name: maybeName.startsWith("1 ") ? `SAT ${satNumber}` : maybeName,
        noradId: satNumber,
        line1,
        line2,
        source,
        fetchedAt: new Date().toISOString()
      });
      index += maybeName.startsWith("1 ") ? 1 : 2;
    }
  }
  return records;
}

async function fetchText(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function fetchCelesTrak(query: { group?: string; noradId?: string; search?: string }) {
  const params = new URLSearchParams({ FORMAT: "TLE" });
  if (query.noradId?.trim()) {
    params.set("CATNR", query.noradId.trim());
  } else {
    params.set("GROUP", query.group?.trim() || "stations");
  }
  const text = await fetchText(`https://celestrak.org/NORAD/elements/gp.php?${params.toString()}`);
  const normalizedSearch = query.search?.trim().toLowerCase();
  const records = parseTleText(text, "celestrak");
  return normalizedSearch
    ? records.filter((record) => record.name.toLowerCase().includes(normalizedSearch))
    : records;
}

async function fetchSpaceTrack(query: { noradId?: string; search?: string }) {
  const credentials = await readCredentials();
  if (!credentials) {
    throw new Error("Space-Track credentials are not saved.");
  }

  const form = new URLSearchParams();
  form.set("identity", credentials.username);
  form.set("password", credentials.password);

  const cookieJar = new Map<string, string>();
  const loginResponse = await fetch("https://www.space-track.org/ajaxauth/login", {
    method: "POST",
    body: form,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
  const setCookie = loginResponse.headers.get("set-cookie");
  if (setCookie) {
    cookieJar.set("Cookie", setCookie.split(";")[0]);
  }
  if (!loginResponse.ok) {
    throw new Error(`Space-Track login failed: ${loginResponse.status}`);
  }

  const trimmedSearch = query.search?.trim();
  const classQuery = query.noradId?.trim()
    ? `NORAD_CAT_ID/${encodeURIComponent(query.noradId.trim())}`
    : trimmedSearch
      ? `OBJECT_NAME/${encodeURIComponent(trimmedSearch.toUpperCase())}~~`
      : "DECAYED/0";
  const url = `https://www.space-track.org/basicspacedata/query/class/gp/${classQuery}/orderby/EPOCH desc/format/tle`;
  const text = await fetchText(url, {
    headers: Object.fromEntries(cookieJar)
  });
  return parseTleText(text, "spacetrack").slice(0, 50);
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: "卫星条带规划工具",
    icon: path.join(__dirname, "../earth.ico"),
    backgroundColor: "#f4f0e7",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    await window.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  installChineseMenu();
  ipcMain.handle("tle:fetchCelesTrak", (_event, query) => fetchCelesTrak(query ?? {}));
  ipcMain.handle("tle:fetchSpaceTrack", (_event, query) => fetchSpaceTrack(query ?? {}));
  ipcMain.handle("tle:saveCredentials", async (_event, credentials: SpaceTrackCredentials) => {
    await writeCredentials(credentials);
    return { saved: true };
  });
  ipcMain.handle("tle:clearCredentials", async () => {
    await fs.rm(credentialsPath(), { force: true });
    return { cleared: true };
  });
  ipcMain.handle("project:export", async (_event, payload) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "导出项目 JSON",
      defaultPath: "stripe-project.json",
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (canceled || !filePath) return { canceled: true };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { canceled: false, filePath };
  });
  ipcMain.handle("project:import", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "导入项目 JSON",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (canceled || !filePaths[0]) return { canceled: true };
    const text = await fs.readFile(filePaths[0], "utf8");
    return { canceled: false, filePath: filePaths[0], data: JSON.parse(text) };
  });

  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
