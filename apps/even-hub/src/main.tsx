import { render } from "@solidjs/web";
import { errorMessage } from "@irl/domain";
import { boot } from "./services";
import { App } from "./ui/App";
import { bumpData, setServices } from "./ui/lib";
import "./ui/style.css";

const root = document.getElementById("root")!;
root.textContent = "Starting…";

boot().then(
  (services) => {
    setServices(services);
    services.dataChanged.on(() => bumpData());
    root.textContent = "";
    render(() => <App />, root);
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
