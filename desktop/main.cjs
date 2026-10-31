const { app, BrowserWindow, dialog } = require("electron");
app.setName("BeamLab");
if (process.platform === "win32")
  app.setAppUserModelId("org.beamlab.instrument");
let runtime;
app.whenReady().then(async () => {
  try {
    const { startServer } = await import("./server.mjs");
    runtime = await startServer();
    const window = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 960,
      minHeight: 720,
      title: "BeamLab 光束分析仪",
      backgroundColor: "#dce2e8",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== runtime.url) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    await window.loadURL(runtime.url);
  } catch (error) {
    dialog.showErrorBox("启动失败", error.message + "\n请先执行 npm run build");
    app.quit();
  }
});
app.on("window-all-closed", () => app.quit());
let exiting = false;
app.on("before-quit", (event) => {
  if (runtime && !exiting) {
    event.preventDefault();
    exiting = true;
    runtime.close().finally(() => app.quit());
  }
});
