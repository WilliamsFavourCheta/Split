import Link from "next/link";
export default function NotFound() { return <div className="error-page"><span className="eyebrow">404 / Route not found</span><h1>This destination<br />doesn’t exist.</h1><p>The route may have moved or the address is invalid.</p><Link className="button button-primary" href="/">Return home</Link></div>; }
