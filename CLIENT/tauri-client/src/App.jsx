import "./App.css";
import Home from "./pages/Home";
import Installer from "./components/Installer";
import About from "./components/About";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import {
  getAllWindows,
  getCurrentWindow,
  Window,
} from "@tauri-apps/api/window";
import { Menu, MenuItem, Submenu } from "@tauri-apps/api/menu";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useState } from "react";
import { Webview } from "@tauri-apps/api/webview";
import { load } from "@tauri-apps/plugin-store";

function App() {
  const [isFirstRun, setIsFirstRun] = useState(null);

  const setupMenu = async () => {
    const menu = await Menu.new({
      items: [
        {
          id: "file",
          text: "File",
          items: [
            await MenuItem.new({
              id: "quit",
              text: "Quit",
              action: () => exit(0),
            }),
            await MenuItem.new({
              id: "restart",
              text: "Restart",
              action: () => relaunch(),
            }),
          ],
        },
        {
          id: "tools",
          text: "Tools",
          items: [
            await MenuItem.new({
              id: "setup",
              text: "Run Setup Again",
              action: () => startAutoInstall(),
            }),
          ],
        },
        {
          id: "help",
          text: "Help",
          items: [
            await MenuItem.new({
              id: "about",
              text: "About",
              action: () => openAboutWindow(),
            }),
          ],
        },
      ],
    });

    const mainWindow = await Window.getByLabel("main");
    if (mainWindow) {
      await menu.setAsWindowMenu(mainWindow);
    }
  };

  const openAboutWindow = async () => {
    const existing = await WebviewWindow.getByLabel("About");
    if (existing) {
      await existing.setFocus();
      return;
    }

    new WebviewWindow("About", {
      url: "/about",
      title: "About AWC",
      width: 440,
      height: 540,
      center: true,
      resizable: false,
    });
  };
  useEffect(() => {
    // App is mounted in each webview; only the main client owns the menu and setup flow.
    if (getCurrentWindow().label !== "main") return;

    setupMenu();
    const initStore = async () => {
      const store = await load("settings.json", { autoSave: false });
      const value = await store.get("isFirstRun")
      setIsFirstRun(value);
      // console.log("isFirstRun: ", value);
      if (value || value === undefined || value === null) {
        await store.set("isFirstRun", true);
        await startAutoInstall().then(async () => {
          await store.set("isFirstRun", false);
        });
      }
      else {
        // console.log("Not first run");
      }

      await store.save();
    };

    initStore();
  }, []);

  // weird tauri problem, you have to reapply menu after focus changed, because the event listeners transfers to the new window
  // and after closing that window, all the listeners are gone. The solutions I found was
  // - creating the menu is Rust and listen for events, or
  // - reapply the menu again.
  // If anyone know/find better approach, please let me know

  const startAutoInstall = async () => {
    console.log("Entered installer window creation.");
    const installerWindow = new WebviewWindow("Installer", {
      url: "/installer",
      width: 480,
      height: 640,
      center: true,
      decorations: false,
    });

    const existing = await Window.getByLabel("Installer");
    if (existing) {
      await existing.setFocus();
      return;
    }

    installerWindow.once("tauri://created", async () => {
      console.log("Installer window created");
    });

    installerWindow.once("tauri://error", (e) => {
      console.error("Failed to create installer window", e);
    });
    installerWindow.once("tauri://destroyed", () => {
      console.log("Installer closed");
      setupMenu();
    });
  };

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/installer" element={<Installer />} />
        <Route path="/about" element={<About />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
