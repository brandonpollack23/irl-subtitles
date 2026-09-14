import { render } from "@solidjs/web";
import { errorMessage } from "@irl/domain";
import { boot } from "./services";
import { App } from "./ui/App";
import { bumpData, setServices } from "./ui/lib";
import "./ui/style.css";

const root = document.getElementById("root")!;
root.textContent = "Starting…";

boot((step) => {
  root.textContent = `${step}…`;
  console.info(`[boot] ${step}`);
}).then(
  (services) => {
    setServices(services);
    services.dataChanged.on(() => bumpData());
    root.textContent = "";
    render(() => <App />, root);
    const params = new URLSearchParams(location.search);
    if (import.meta.env.DEV && params.get("bench") === "live") void import("./bench").then((m) => m.runBench(services, params));
  },
  (e) => {
    console.error(e);
    root.innerHTML = "";
    const p = document.createElement("p");
    p.style.padding = "16px";
    p.textContent = `IRL Subtitles couldn't start: ${errorMessage(e)}`;
    root.append(p);
  },
);
