import { render } from "@solidjs/web";
import { errorMessage } from "@irl/domain";
import { locale, localeChanges, resolveLocale, setLocale, t } from "@irl/i18n";
import { boot } from "./services";
import { App } from "./ui/App";
import { bumpData, setServices } from "./ui/lib";
import "./ui/style.css";

const root = document.getElementById("root")!;
// Settings aren't open yet: boot text follows the phone's languages.
setLocale(resolveLocale("system"));
document.documentElement.lang = locale();
root.textContent = t().boot.step(t().boot.starting);

boot((step) => {
  root.textContent = t().boot.step(t().boot.steps[step]);
  console.info(`[boot] ${step}`);
}).then(
  (services) => {
    setServices(services);
    services.dataChanged.on(() => bumpData());
    const applyLocale = () => setLocale(resolveLocale(services.settings.get().uiLanguage));
    applyLocale();
    services.settings.changes.on(applyLocale);
    addEventListener("languagechange", applyLocale);
    document.documentElement.lang = locale();
    root.textContent = "";
    let dispose = render(() => <App />, root);
    // A language switch re-mounts the UI so every string follows; the hash route keeps the same screen.
    localeChanges.on((l) => {
      document.documentElement.lang = l;
      dispose();
      dispose = render(() => <App />, root);
    });
    const params = new URLSearchParams(location.search);
    if (import.meta.env.DEV && params.get("bench") === "live") void import("./bench").then((m) => m.runBench(services, params));
  },
  (e) => {
    console.error(e);
    root.innerHTML = "";
    const p = document.createElement("p");
    p.style.padding = "16px";
    p.textContent = t().boot.failed(errorMessage(e));
    root.append(p);
  },
);
