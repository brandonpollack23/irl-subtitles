import { render } from "@solidjs/web";
import { App } from "./App";
import { getBridge, hud } from "./bridge";
import "./style.css";

render(() => <App />, document.getElementById("root")!);

// Create the glasses page at launch so its contextual menu (Start/Stop/Marker) is
// available before anything is pressed on the phone.
void getBridge().then((bridge) => bridge && hud.ensurePage());
