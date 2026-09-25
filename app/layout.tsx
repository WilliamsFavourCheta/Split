import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import { AppProviders } from "./components/providers";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "SPLIT — Give every fee a destination", template: "%s | SPLIT" },
  description: "Launch tokens with transparent, programmable fee distribution on Robinhood Chain.",
  icons: {
    icon: [{ url: "/icon.png?v=split-mark-1", type: "image/png", sizes: "any" }],
    shortcut: ["/icon.png?v=split-mark-1"],
    apple: [{ url: "/icon.png?v=split-mark-1", type: "image/png", sizes: "180x180" }],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} h-full antialiased`}
    >
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
