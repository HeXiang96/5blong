const {
  app,
  BrowserWindow,
  protocol,
  session,
  shell,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

// 自定义 app:// 协议：桌面端用它加载 dist-web，而不是 file://。
// 原因：file:// 的 opaque origin 会让 wasm 的 fetch（RNNoise）触发 CORS 失败。
// 必须在 app ready 之前注册特权。
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportServiceWorkers: true,
      corsEnabled: true,
    },
  },
]);

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** 把 app://bundle/<相对路径> 映射到 dist-web 并返回文件响应。 */
function registerAppProtocol() {
  const webRoot = path.normalize(path.join(__dirname, "..", "dist-web"));
  protocol.handle("app", (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (rel === "" || rel.endsWith("/")) rel += "index.html";
      const file = path.normalize(path.join(webRoot, rel));
      // 防路径穿越：解析后必须仍在 dist-web 内。
      if (!file.startsWith(webRoot)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return new Response("Not Found", { status: 404 });
      }
      const data = fs.readFileSync(file);
      const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      return new Response(data, { headers: { "Content-Type": mime } });
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
  });
}

const isDev = !app.isPackaged && process.env.VOX_DEV === "1";
/** 启动自检模式：验证打包产物能真正跑起来，然后自动退出。用环境变量传，避免被 Chromium 当命令行开关。 */
const isSmoke = process.env.VOX_SMOKE === "1";
/** 自检结果写文件：Windows 上 GUI 进程的 stdout 抓不到，写文件最可靠。 */
const smokeOut = process.env.VOX_SMOKE_OUT || "";
function smokeLog(line) {
  if (!smokeOut) return;
  try {
    require("fs").appendFileSync(smokeOut, `${line}\n`, "utf8");
  } catch {
    /* 写不进去就只能靠退出码 */
  }
}
if (isSmoke) {
  smokeLog(`SMOKE_MODULE_LOADED pid=${process.pid} electron=${process.versions.electron} argv=${process.argv.join(" ")}`);
  process.on("uncaughtException", (error) => {
    smokeLog(`SMOKE_RESULT fail uncaughtException ${error && error.stack}`);
    app.exit(1);
  });
}

let mainWindow = null;
let tray = null;
let isQuiting = false;

/**
 * 首次运行时在桌面放一个快捷方式。
 *
 * 行为：
 * - **桌面没有就建**（这就是全部条件）；
 * - 已经有同名快捷方式就什么都不做（不覆盖、不改用户设过的属性）；
 * - **任何失败都静默忽略**——绝不能因为建不了快捷方式就打不开应用；
 * - 启动自检（VOX_SMOKE）时不执行，免得自动化测试在别人桌面上乱放东西。
 *
 * 关于"标记文件"：以前这里会在建成后写 `userData/desktop-shortcut` 标记，
 * 之后只要标记在、桌面上没有 lnk，就判定为"用户主动删过，不再重建"。
 * 那个判断是错的——它区分不了"用户删掉了"和"创建过、后来因为任何原因不在了"，
 * 结果就是桌面上的 lnk 一旦消失就**再也建不出来**（实测踩到）。
 * 需求是"没有就自动建"，所以现在只看桌面状态，不留标记。
 *
 * 实现说明：不自己拼 .lnk 的二进制格式，而是用 WScript.Shell COM。
 * 用户在开始菜单里手动设过属性的快捷方式也照样能被正确读取/跳过。
 */
function ensureDesktopShortcut() {
  if (process.platform !== "win32") return;
  try {
    // 没打包的 electron.exe 不算"用户第一次运行"，不建。
    if (!app.isPackaged) return;

    const exePath = process.execPath;
    // 测试用：允许指定目录，避免自动化测试往真实桌面上放东西。
    const desktop = process.env.SHORTCUT_DESKTOP_DIR || app.getPath("desktop");
    if (!desktop) return;

    const linkName = "5blong.lnk";
    const linkPath = path.join(desktop, linkName);
    if (fs.existsSync(linkPath)) {
      shortcutLog("已存在，跳过");
      return;
    }

    const iconPath = path.join(__dirname, "assets", "icon.ico");
    const workDir = path.dirname(exePath);
    // 用单引号包字符串，内部单引号转义为两个，避免注入与转义问题
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      "$sh = New-Object -ComObject WScript.Shell",
      `$sc = $sh.CreateShortcut(${q(linkPath)})`,
      `$sc.TargetPath = ${q(exePath)}`,
      `$sc.WorkingDirectory = ${q(workDir)}`,
      "$sc.Description = '5blong 临时语音房'",
      fs.existsSync(iconPath) ? `$sc.IconLocation = ${q(`${iconPath},0`)}` : "",
      "$sc.Save()",
    ]
      .filter(Boolean)
      .join("; ");

    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { timeout: 15000, windowsHide: true, stdio: "ignore" },
    );

    if (result.status === 0 && fs.existsSync(linkPath)) {
      shortcutLog(`已创建 ${linkPath}`);
    } else {
      shortcutLog(`创建失败（status=${result.status}）`);
    }
  } catch (error) {
    shortcutLog(`异常已忽略：${error && error.message}`);
  }
}

function shortcutLog(message) {
  const out = process.env.SHORTCUT_LOG;
  if (out) {
    try {
      fs.appendFileSync(out, `SHORTCUT_${message}\n`, "utf8");
    } catch {
      /* 忽略 */
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: "#141e29",
    title: "5blong",
    icon: path.join(__dirname, "assets", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // 点右上角 ×：不退出，最小化到系统托盘后台运行（语音保持）。
  mainWindow.on("close", (event) => {
    if (!isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // 外部链接交给系统浏览器，不在应用内打开。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:8787/");
  } else {
    // 经特权 app:// 协议加载（见文件顶部 registerAppProtocol），wasm 才能正常 fetch。
    mainWindow.loadURL("app://bundle/index.html");
  }
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, "assets", "tray.png");
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image);
  tray.setToolTip("5blong");

  const menu = Menu.buildFromTemplate([
    { label: "显示 5blong", click: showWindow },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", showWindow);
}

// 桌面端自动授予媒体（麦克风）权限，避免原生权限条打断"开聊"。
function allowPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  ses.setPermissionCheckHandler(() => true);
}

if (process.platform === "win32") {
  app.setAppUserModelId("com.5blong.app");
}

// 单实例：再次启动时聚焦已有窗口，而不是开新进程。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    smokeLog("SMOKE_READY");
    registerAppProtocol();
    allowPermissions();
    createWindow();
    if (isSmoke) {
      runSmokeTest();
      return;
    }
    createTray();
    app.on("activate", showWindow);
    // 首次运行放一个桌面快捷方式（失败静默，不影响使用）
    ensureDesktopShortcut();
  });

  app.on("window-all-closed", () => {
    // 常驻托盘：非显式退出时不结束进程。
    if (isQuiting) app.quit();
  });
}

/**
 * 启动自检：node scripts/smoke-desktop.mjs
 * 不建托盘、不显示窗口，只验证「asar 能加载 + 渲染进程能跑通 CSS/JS + preload 路径正确」，
 * 然后把结论打到 stdout 并退出。用于打包后的可验证性。
 */
function runSmokeTest() {
  const wc = mainWindow.webContents;
  let reported = false;
  const finish = (ok, detail) => {
    if (reported) return;
    reported = true;
    smokeLog(`SMOKE_RESULT ${ok ? "ok" : "fail"} ${detail}`);
    isQuiting = true;
    app.exit(ok ? 0 : 1);
  };

  wc.on("did-fail-load", (_event, code, description, url) => {
    finish(false, `did-fail-load ${code} ${description} ${url}`);
  });
  wc.on("render-process-gone", (_event, details) => {
    finish(false, `render-process-gone ${details.reason}`);
  });
  wc.on("console-message", (_event, level, message) => {
    smokeLog(`SMOKE_CONSOLE ${level} ${message}`);
  });

  wc.once("did-finish-load", async () => {
    smokeLog("SMOKE_LOADED");
    try {
      const report = await wc.executeJavaScript(
        `(() => ({
           root: !!document.getElementById("root"),
           rendered: (document.getElementById("root")?.childElementCount ?? 0) > 0,
           reactButtons: document.querySelectorAll("button").length,
           title: document.title,
           styles: getComputedStyle(document.body).backgroundColor,
         }))()`,
        true,
      );
      const ok = report.root && report.rendered && report.reactButtons > 0;
      finish(ok, JSON.stringify(report));
    } catch (error) {
      finish(false, `executeJavaScript failed: ${error && error.message}`);
    }
  });

  setTimeout(() => finish(false, "timeout waiting for did-finish-load"), 20000);
}
