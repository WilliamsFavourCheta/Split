"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <div className="error-page"><span className="eyebrow">Application error</span><h1>Something broke<br />in the route.</h1><p>The interface could not load this view. Your local launch draft is still safe.</p><button className="button button-primary" onClick={reset}>Try again</button></div>;
}
