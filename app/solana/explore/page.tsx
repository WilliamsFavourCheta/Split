import Link from "next/link";
import { connection } from "next/server";
import { getSolanaProjects } from "../../lib/solana/repository";
import { solanaCluster } from "../../lib/solana/client";

export default async function SolanaExplorePage() {
  await connection();
  let projects: Awaited<ReturnType<typeof getSolanaProjects>> = [];
  let unavailable = false;
  try { projects = await getSolanaProjects(); }
  catch { unavailable = true; }
  return <div className="section-shell solana-page"><span className="eyebrow">{solanaCluster} · finalized projects</span><h1>Explore launches.</h1>
    {unavailable ? <p>The Solana project index is not available yet. Launches will appear after the database migration and finalized-slot indexer are active.</p> : projects.length ? <div className="solana-project-list">{projects.map((project) => <Link href={`/solana/token/${project.mint_address}`} key={project.mint_address} className="glass-panel solana-project-row"><span><strong>{project.name}</strong><small>{project.symbol} · {project.status === "curve" ? "Bonding curve" : "Graduated"}</small></span><span className="solana-project-mint">{project.mint_address.slice(0, 6)}…{project.mint_address.slice(-6)}</span></Link>)}</div> : <p>No finalized SPLIT Solana launches have been indexed on this cluster.</p>}
  </div>;
}
