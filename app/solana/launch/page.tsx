import { SolanaLaunchForm } from "../../components/solana/launch-form";
import { SolanaReadinessNotice } from "../../components/solana/readiness-notice";

export default function SolanaLaunchPage() { return <><SolanaLaunchForm /><div className="section-shell"><SolanaReadinessNotice /></div></>; }
