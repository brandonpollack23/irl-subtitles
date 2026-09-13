import { ActionButton, Card, createReporter, ReportCard } from "../components";
import { storeTestSecret, verifyTestSecret } from "../spikes/secrets";

export function SecretsPanel() {
  const reporter = createReporter("secrets");
  return (
    <>
      <Card title="Spike irl-subt-0i6.6 — encrypted secret persistence">
        <p class="muted">
          Store once on the old build, then relaunch / force-stop / install a newer .ehpk and press Verify each time. Uses a
          random test value, never a real API key.
        </p>
        <div class="row">
          <ActionButton label="Store test secret" onRun={async () => reporter.publish({ kind: "store", ...(await storeTestSecret()) })} />
          <ActionButton label="Verify" onRun={async () => reporter.publish({ kind: "verify", ...(await verifyTestSecret()) })} />
        </div>
      </Card>
      <ReportCard status={reporter.status()} json={reporter.json()} />
    </>
  );
}
