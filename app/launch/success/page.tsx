import { Suspense } from "react";
import { OnchainLaunchSuccessPage } from "../../components/onchain-launch-flow";
export default function Page() { return <Suspense fallback={<main className="section-shell page-body" aria-busy="true">Loading confirmed launch…</main>}><OnchainLaunchSuccessPage /></Suspense>; }
