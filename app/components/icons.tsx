import type { SVGProps } from "react";

export type IconName =
  | "arrow" | "back" | "bars" | "chart" | "check" | "chevron" | "close"
  | "copy" | "discord" | "external" | "globe" | "layers" | "lock" | "menu"
  | "search" | "settings" | "telegram" | "twitter" | "upload" | "wallet";

const paths: Record<IconName, React.ReactNode> = {
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  back: <path d="m15 18-6-6 6-6" />,
  bars: <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></>,
  chart: <><path d="M3 3v18h18" /><path d="m7 16 4-5 4 3 5-7" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>,
  discord: <><path d="M8.5 8.8a7.8 7.8 0 0 1 7 0" /><path d="M6.3 6.6C3.8 10.2 3.2 13.7 3.5 17c2.3 1.7 4.4 2.2 6.4 2.3l.8-1.2" /><path d="M17.7 6.6c2.5 3.6 3.1 7.1 2.8 10.4-2.3 1.7-4.4 2.2-6.4 2.3l-.8-1.2" /><circle cx="9" cy="13" r="1" /><circle cx="15" cy="13" r="1" /></>,
  external: <><path d="M15 4h5v5" /><path d="m20 4-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18" /><path d="M12 3a14 14 0 0 0 0 18" /></>,
  layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  telegram: <path d="m21 3-7.2 18-3.6-6.2L4 11.2 21 3Zm-10.8 11.8L21 3" />,
  twitter: <path d="M18 2h3l-6.6 7.5L22 22h-6l-4.7-6.2L5.8 22H2.7l7.1-8.1L2.5 2h6.2l4.2 5.6L18 2Z" />,
  upload: <><path d="M12 3v12" /><path d="m7 8 5-5 5 5" /><path d="M5 13v6h14v-6" /></>,
  wallet: <><path d="M4 6h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h12" /><path d="M16 12h5" /></>,
};

export function Icon({ name, size = 18, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
