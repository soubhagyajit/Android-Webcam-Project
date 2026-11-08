import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

const projectUrl = "https://github.com/soubhagyajit/Android-Webcam-Project";
const licenseUrl = `${projectUrl}?tab=GPL-3.0-1-ov-file`;

function About() {
  const [version, setVersion] = useState("Loading…");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((error) => {
        console.error("Could not load app version:", error);
        setVersion("Unavailable");
      });
  }, []);

  const followLink = (url) => (event) => {
    event.preventDefault();
    openUrl(url).catch((error) => console.error("Could not open link:", error));
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-8 text-center">
      <h1 className="text-2xl font-semibold">Android Webcam Client</h1>
      <p className="mt-2 text-sm text-slate-400">AWC Version {version}</p>
      <p className="mt-1 text-sm text-slate-400">Author: Soubhagyajit Borah</p>

      <section className="mt-6 text-center">
        <div className="flex flex-col gap-2 text-sm">
          <a className="text-brand-400 hover:text-brand-300 underline underline-offset-4" href={projectUrl} onClick={followLink(projectUrl)}>GitHub Project</a>
          <a className="text-brand-400 hover:text-brand-300 underline underline-offset-4" href={licenseUrl} onClick={followLink(licenseUrl)}>GNU General Public License v3.0</a>
        </div>
      </section>

      <section className="mt-6 text-center">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Acknowledgments</h2>
        <p className="mt-1 text-xs text-slate-500">Special thanks to these amazing projects:</p>
        <div className="mt-2 flex flex-col gap-2 text-sm">
          <a className="text-brand-400 hover:text-brand-300 underline underline-offset-4" href="https://github.com/tshino/softcam" onClick={followLink("https://github.com/tshino/softcam")}>softcam driver by tshino</a>
          <a className="text-brand-400 hover:text-brand-300 underline underline-offset-4" href="https://github.com/pedroSG94" onClick={followLink("https://github.com/pedroSG94")}>Rootencoder &amp; RTSP-Server by pedroSG94</a>
        </div>
      </section>
    </main>
  );
}

export default About;
