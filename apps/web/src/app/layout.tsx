import type { Metadata } from "next";
import {
  Familjen_Grotesk,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
} from "next/font/google";

import "./globals.css";

/*
 * Fonts are self-hosted: Next downloads and serves them from this origin at
 * build time, so the product makes no runtime request to a font CDN. Subsets
 * and fallbacks are explicit.
 */
const display = Familjen_Grotesk({
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
  variable: "--font-familjen-grotesk",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
  variable: "--font-ibm-plex-sans",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
  variable: "--font-ibm-plex-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "monospace"],
});

export const metadata: Metadata = {
  title: "CodeAtlas",
  description:
    "Reproducible evidence for a base and head comparison, before merge.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // The font variables must land on the same element that declares the
    // `--font-*` tokens in globals.css. Substitution happens where a custom
    // property is computed, so declaring them lower than :root would leave
    // every token invalid and fall back to the browser default serif.
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
